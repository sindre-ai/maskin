import type { Built } from './calendar'
import { GRAPH_BASE } from './graph'

/**
 * OneDrive and SharePoint files for the Microsoft MCP tools (./mcp-server.ts). Pure: builds the
 * Graph addresses, validates what an agent passed, and trims drive items to the fields an agent
 * needs. No I/O here, so every rule is unit-tested without a server.
 *
 * Without a site_id every address is on the connected person's own OneDrive (/me/drive). With one
 * it is the default document library of that SharePoint site. Files are text only: read returns
 * text files, upload writes text.
 */

export const FILES_DEFAULT_LIMIT = 25
export const FILES_MAX_LIMIT = 50
export const SITES_MAX_LIMIT = 25
/** Biggest file whose text is downloaded for an agent. Bigger ones come back as details only. */
export const MAX_READ_BYTES = 1_000_000
/** Characters of file text handed to the agent in one call. */
export const MAX_READ_CHARS = 30_000
/** Biggest upload, in bytes. Graph's simple upload takes far more; this is ours, and it is not retried. */
export const MAX_UPLOAD_BYTES = 1_000_000

const MAX_ID_LENGTH = 1_000
const MAX_QUERY_LENGTH = 200
const MAX_SEGMENT_LENGTH = 255
const MAX_PATH_LENGTH = 400
const SITE_ID_PATTERN = /^[A-Za-z0-9.,_-]{1,300}$/
// What OneDrive and SharePoint refuse in a file or folder name, plus control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const BAD_NAME_CHARS = /["*:<>?/\\|\u0000-\u001f]/

const ITEM_SELECT = [
	'id',
	'name',
	'size',
	'webUrl',
	'lastModifiedDateTime',
	'createdDateTime',
	'folder',
	'file',
	'parentReference',
	'lastModifiedBy',
].join(',')

function clampLimit(limit: number | undefined, max: number): number {
	if (limit === undefined || !Number.isFinite(limit)) return FILES_DEFAULT_LIMIT
	return Math.min(max, Math.max(1, Math.trunc(limit)))
}

/** The drive an address is on, or why it cannot be built. */
function driveBase(siteId: string | undefined): Built<{ base: string }> {
	if (siteId === undefined || siteId.trim() === '')
		return { ok: true, base: `${GRAPH_BASE}/me/drive` }
	const id = siteId.trim()
	if (!SITE_ID_PATTERN.test(id)) {
		return { ok: false, message: 'site_id must be a site id from sharepoint_search_sites.' }
	}
	return { ok: true, base: `${GRAPH_BASE}/sites/${encodeURIComponent(id)}/drive` }
}

function itemId(id: string): string | null {
	const trimmed = id.trim()
	return trimmed === '' || trimmed.length > MAX_ID_LENGTH ? null : trimmed
}

const ITEM_ID_MESSAGE =
	'item_id must be a file id from onedrive_list_files or onedrive_search_files.'

/** A folder path as encoded address segments, or a message. '' (or '/') is the root. */
function folderSegments(path: string | undefined): string[] | string {
	const segments = (path ?? '')
		.split('/')
		.map((s) => s.trim())
		.filter((s) => s !== '')
	for (const segment of segments) {
		if (segment === '.' || segment === '..' || BAD_NAME_CHARS.test(segment)) {
			return `folder_path "${path}" has a part that is not a valid folder name.`
		}
		if (segment.length > MAX_SEGMENT_LENGTH) {
			return `A folder name in folder_path is longer than ${MAX_SEGMENT_LENGTH} characters.`
		}
	}
	if (segments.join('/').length > MAX_PATH_LENGTH) {
		return `folder_path can be at most ${MAX_PATH_LENGTH} characters.`
	}
	return segments
}

const encodePath = (segments: string[]) => segments.map(encodeURIComponent).join('/')

/** SharePoint sites matching some text. Needs Sites.Read.All; this is the only call that does. */
export function buildSiteSearchRequest(input: {
	query: string
	limit?: number
}): Built<{ url: string; limit: number }> {
	const query = input.query.replace(/\s+/g, ' ').trim()
	if (query === '' || query.length > MAX_QUERY_LENGTH) {
		return { ok: false, message: `query must be 1 to ${MAX_QUERY_LENGTH} characters.` }
	}
	const limit = clampLimit(input.limit, SITES_MAX_LIMIT)
	return {
		ok: true,
		url: `${GRAPH_BASE}/sites?search=${encodeURIComponent(query)}&$select=id,name,displayName,webUrl,description`,
		limit,
	}
}

/** The items in one folder (the root by default), folders first as Graph returns them. */
export function buildListFilesRequest(input: {
	site_id?: string
	folder_path?: string
	limit?: number
}): Built<{ url: string; limit: number }> {
	const drive = driveBase(input.site_id)
	if (!drive.ok) return drive
	const segments = folderSegments(input.folder_path)
	if (typeof segments === 'string') return { ok: false, message: segments }
	const limit = clampLimit(input.limit, FILES_MAX_LIMIT)
	const folder = segments.length === 0 ? '/root' : `/root:/${encodePath(segments)}:`
	return {
		ok: true,
		url: `${drive.base}${folder}/children?$top=${limit + 1}&$select=${ITEM_SELECT}`,
		limit,
	}
}

/** Graph's file search in one drive: names, metadata and file text. One page. */
export function buildSearchFilesRequest(input: {
	query: string
	site_id?: string
	limit?: number
}): Built<{ url: string; limit: number }> {
	const drive = driveBase(input.site_id)
	if (!drive.ok) return drive
	const query = input.query.replace(/\s+/g, ' ').trim()
	if (query === '' || query.length > MAX_QUERY_LENGTH) {
		return { ok: false, message: `query must be 1 to ${MAX_QUERY_LENGTH} characters.` }
	}
	const limit = clampLimit(input.limit, FILES_MAX_LIMIT)
	// The text sits inside q='...': a quote is doubled to stay inside it.
	const quoted = encodeURIComponent(query.replace(/'/g, "''"))
	return {
		ok: true,
		url: `${drive.base}/root/search(q='${quoted}')?$top=${limit + 1}&$select=${ITEM_SELECT}`,
		limit,
	}
}

/** Details of one item, and the address of its content. */
export function buildGetFileRequest(input: {
	item_id: string
	site_id?: string
}): Built<{ url: string; contentUrl: string }> {
	const drive = driveBase(input.site_id)
	if (!drive.ok) return drive
	const id = itemId(input.item_id)
	if (id === null) return { ok: false, message: ITEM_ID_MESSAGE }
	// Item ids can hold characters that mean something in an address, so encode them whole.
	const item = `${drive.base}/items/${encodeURIComponent(id)}`
	return { ok: true, url: `${item}?$select=${ITEM_SELECT}`, contentUrl: `${item}/content` }
}

/**
 * One text file written into a folder (the root by default). By default it fails if the name is
 * taken; `overwrite` replaces the file instead. Folders on the way are created by Graph.
 */
export function buildUploadRequest(input: {
	name: string
	content: string
	folder_path?: string
	site_id?: string
	overwrite?: boolean
}): Built<{ url: string; content: string }> {
	const drive = driveBase(input.site_id)
	if (!drive.ok) return drive
	const name = input.name.trim()
	if (name === '' || name === '.' || name === '..' || BAD_NAME_CHARS.test(name)) {
		return {
			ok: false,
			message: 'name must be a file name, with no slash or other path characters.',
		}
	}
	if (name.length > MAX_SEGMENT_LENGTH) {
		return { ok: false, message: `name can be at most ${MAX_SEGMENT_LENGTH} characters.` }
	}
	const segments = folderSegments(input.folder_path)
	if (typeof segments === 'string') return { ok: false, message: segments }
	if (input.content === '') return { ok: false, message: 'content must not be empty.' }
	if (Buffer.byteLength(input.content, 'utf8') > MAX_UPLOAD_BYTES) {
		return { ok: false, message: `content can be at most ${MAX_UPLOAD_BYTES} bytes.` }
	}
	const behaviour = input.overwrite ? 'replace' : 'fail'
	return {
		ok: true,
		url: `${drive.base}/root:/${encodePath([...segments, name])}:/content?@microsoft.graph.conflictBehavior=${behaviour}`,
		content: input.content,
	}
}

// ── Trimming ─────────────────────────────────────────────────────────────

export interface GraphSite {
	id?: string
	name?: string
	displayName?: string
	webUrl?: string
	description?: string
}

export function trimSite(raw: GraphSite) {
	return {
		id: raw.id ?? null,
		name: raw.displayName || raw.name || '',
		web_url: raw.webUrl ?? null,
		description: raw.description || null,
	}
}

export interface GraphDriveItem {
	id?: string
	name?: string
	size?: number
	webUrl?: string
	lastModifiedDateTime?: string
	createdDateTime?: string
	folder?: { childCount?: number }
	file?: { mimeType?: string }
	parentReference?: { path?: string }
	lastModifiedBy?: { user?: { displayName?: string } }
}

export function trimItem(raw: GraphDriveItem) {
	return {
		id: raw.id ?? null,
		name: raw.name ?? '',
		type: raw.folder ? 'folder' : 'file',
		size: raw.size ?? null,
		mime_type: raw.file?.mimeType ?? null,
		child_count: raw.folder?.childCount ?? null,
		// Graph writes the parent as /drive/root:/Folder, which is the person's own path.
		folder: raw.parentReference?.path?.replace(/^.*?root:/, '') || '/',
		modified_at: raw.lastModifiedDateTime ?? null,
		modified_by: raw.lastModifiedBy?.user?.displayName ?? null,
		web_url: raw.webUrl ?? null,
	}
}

const TEXT_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/x-yaml',
	'application/yaml',
	'application/javascript',
	'application/csv',
])
const TEXT_EXTENSIONS =
	/\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|log|ini|toml|js|ts|py|sql)$/i

/** Whether the file is plain text we can hand to an agent. Office files and PDFs are not. */
export function isTextFile(raw: GraphDriveItem): boolean {
	if (!raw.file) return false
	const mime = (raw.file.mimeType ?? '').toLowerCase()
	if (mime.startsWith('text/') || TEXT_TYPES.has(mime)) return true
	return TEXT_EXTENSIONS.test(raw.name ?? '')
}

/** Why the text of this item is not downloaded, or null when it can be. */
export function readBlocker(raw: GraphDriveItem): string | null {
	if (raw.folder) return 'This is a folder. Use onedrive_list_files to see what is in it.'
	if (!isTextFile(raw)) {
		return 'Only plain text files can be read here (txt, md, csv, json and similar). Open it with the web link instead.'
	}
	if ((raw.size ?? 0) > MAX_READ_BYTES) {
		return `This file is bigger than ${MAX_READ_BYTES} bytes, so its text is not read here.`
	}
	return null
}

/** The first MAX_READ_CHARS of the text, and whether anything was cut. */
export function cutText(text: string): { text: string; truncated: boolean } {
	return text.length > MAX_READ_CHARS
		? { text: text.slice(0, MAX_READ_CHARS), truncated: true }
		: { text, truncated: false }
}
