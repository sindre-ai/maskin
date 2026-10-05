import {
	type DocElement,
	GOOGLE_DOC_MIME,
	GOOGLE_SHEET_MIME,
	parseDocBody,
	parseSheetBody,
	sheetValuesRequests,
	textRunRequests,
} from './doc-body'
import {
	DRIVE_FILE_FIELDS,
	type DriveFileResource,
	MULTIPART_MAX_BYTES,
	multipartUpload,
	resumableUpload,
} from './upload'
import { invalidInput } from './write-errors'
import { DOCS_API, DRIVE_API, type DriveHttp, SHEETS_API, googleJson } from './write-http'

export type WriteFileContent =
	| string
	| { encoding: 'base64'; data: string }
	| { storageUrl: string }

export interface WriteFileInput {
	name: string
	parentFolderId?: string
	mimeType: string
	content?: WriteFileContent
	docStructuredBody?: unknown
}

export interface WriteFileOutput {
	fileId: string
	name: string
	mimeType: string
	webViewLink?: string
	driveFileVersion?: string
}

/** Which of the write paths served the call; used for telemetry only. */
export type WriteFilePath = 'multipart' | 'resumable' | 'doc' | 'sheet'

/** A readable storage object. size is set when the storage layer knows it. */
export interface StorageSource {
	stream: AsyncIterable<Uint8Array>
	size?: number
}

export interface WriteFileContext {
	http: DriveHttp
	workspaceId: string
	/** Opens the storage object behind a storageUrl (a storage key). Only called after the workspace-prefix check. */
	openStorageObject?: (key: string) => Promise<StorageSource>
}

const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.'

function toOutput(file: DriveFileResource): WriteFileOutput {
	return {
		fileId: file.id,
		name: file.name,
		mimeType: file.mimeType,
		...(file.webViewLink && { webViewLink: file.webViewLink }),
		...(file.version && { driveFileVersion: file.version }),
	}
}

/**
 * A storageUrl is a storage key (as google_drive__get_file_bytes returns).
 * It must sit under the caller's own workspace prefix: without this check an
 * agent could copy another workspace's stored objects into its own Drive.
 */
export function assertWorkspaceStorageKey(key: string, workspaceId: string): void {
	const prefix = `workspaces/${workspaceId}/`
	if (!key.startsWith(prefix) || key.split('/').some((part) => part === '..' || part === '.')) {
		throw invalidInput(
			'storageUrl must be a storage key inside this workspace.',
			`Expected a key starting with "${prefix}", such as the storageUrl google_drive__get_file_bytes returned.`,
		)
	}
}

async function* chunksOf(data: Buffer, size: number): AsyncGenerator<Uint8Array> {
	for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}

function decodeInline(content: string | { encoding: 'base64'; data: string }): Buffer {
	if (typeof content === 'string') return Buffer.from(content, 'utf8')
	const normalized = content.data.replace(/\s+/g, '')
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
		throw invalidInput('content.data is not valid base64.')
	}
	return Buffer.from(normalized, 'base64')
}

export async function writeFile(
	ctx: WriteFileContext,
	input: WriteFileInput,
): Promise<{ output: WriteFileOutput; path: WriteFilePath }> {
	const { http } = ctx
	const meta = { name: input.name, mimeType: input.mimeType, parentFolderId: input.parentFolderId }
	const isDoc = input.mimeType === GOOGLE_DOC_MIME
	const isSheet = input.mimeType === GOOGLE_SHEET_MIME

	if (input.mimeType.startsWith(GOOGLE_NATIVE_PREFIX) && !isDoc && !isSheet) {
		throw invalidInput(
			`Creating ${input.mimeType} is not supported.`,
			'Supported Google-native types: Docs and Sheets, created from docStructuredBody.',
		)
	}

	if (isDoc || isSheet) {
		if (input.docStructuredBody === undefined) {
			throw invalidInput(
				`A ${isDoc ? 'Doc' : 'Sheet'} is created from docStructuredBody, which was not provided.`,
			)
		}
		return isDoc
			? { output: await createDoc(http, meta, parseDocBody(input.docStructuredBody)), path: 'doc' }
			: {
					output: await createSheet(http, meta, parseSheetBody(input.docStructuredBody)),
					path: 'sheet',
				}
	}

	if (input.docStructuredBody !== undefined) {
		throw invalidInput(
			'docStructuredBody only applies to Google Docs and Sheets.',
			`Set mimeType to ${GOOGLE_DOC_MIME} or ${GOOGLE_SHEET_MIME}, or send the bytes in content.`,
		)
	}
	if (input.content === undefined) throw invalidInput('content is required.')

	if (typeof input.content === 'object' && 'storageUrl' in input.content) {
		const key = input.content.storageUrl
		assertWorkspaceStorageKey(key, ctx.workspaceId)
		if (!ctx.openStorageObject) {
			throw invalidInput('storageUrl uploads are not available on this server.')
		}
		const source = await ctx.openStorageObject(key)
		const file = await resumableUpload(http, {
			meta,
			source: source.stream,
			totalSize: source.size,
		})
		return { output: toOutput(file), path: 'resumable' }
	}

	const data = decodeInline(input.content)
	if (data.length < MULTIPART_MAX_BYTES) {
		return { output: toOutput(await multipartUpload(http, meta, data)), path: 'multipart' }
	}
	// Inline content of 5 MB or more: same resumable path as storage objects.
	const file = await resumableUpload(http, {
		meta,
		source: chunksOf(data, 1024 * 1024),
		totalSize: data.length,
	})
	return { output: toOutput(file), path: 'resumable' }
}

/** files.create mints the empty Google-native file in the target folder. */
async function mintEmptyFile(
	http: DriveHttp,
	meta: { name: string; mimeType: string; parentFolderId?: string },
): Promise<DriveFileResource> {
	return googleJson<DriveFileResource>(
		http,
		`${DRIVE_API}/files?supportsAllDrives=true&fields=${DRIVE_FILE_FIELDS}`,
		{
			method: 'POST',
			body: {
				name: meta.name,
				mimeType: meta.mimeType,
				...(meta.parentFolderId && { parents: [meta.parentFolderId] }),
			},
		},
	)
}

async function docsBatchUpdate(http: DriveHttp, documentId: string, requests: object[]) {
	await googleJson(http, `${DOCS_API}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
		method: 'POST',
		body: { requests },
	})
}

interface DocTableElement {
	endIndex?: number
	table?: {
		tableRows?: Array<{ tableCells?: Array<{ content?: Array<{ startIndex?: number }> }> }>
	}
}

async function createDoc(
	http: DriveHttp,
	meta: { name: string; mimeType: string; parentFolderId?: string },
	elements: DocElement[],
): Promise<WriteFileOutput> {
	const file = await mintEmptyFile(http, meta)
	// A new Doc is one empty paragraph at [1, 2): text goes in at index 1.
	let cursor = 1
	let run: Exclude<DocElement, { type: 'table' }>[] = []

	const flushRun = async () => {
		if (run.length === 0) return
		const built = textRunRequests(run, cursor)
		await docsBatchUpdate(http, file.id, built.requests)
		cursor = built.cursor
		run = []
	}

	for (const el of elements) {
		if (el.type !== 'table') {
			run.push(el)
			continue
		}
		await flushRun()
		await docsBatchUpdate(http, file.id, [
			{
				insertTable: {
					rows: el.cells.length,
					columns: el.cells[0]?.length ?? 1,
					endOfSegmentLocation: { segmentId: '' },
				},
			},
		])
		// Cell positions come from Google, not from arithmetic on the table layout.
		const doc = await googleJson<{ body?: { content?: DocTableElement[] } }>(
			http,
			`${DOCS_API}/documents/${encodeURIComponent(file.id)}?fields=body(content(endIndex,table(tableRows(tableCells(content(startIndex))))))`,
		)
		const content = doc.body?.content ?? []
		const table = [...content].reverse().find((c) => c.table)
		const bodyEnd = content[content.length - 1]?.endIndex
		if (!table?.table?.tableRows || bodyEnd === undefined) {
			throw invalidInput('Google did not return the table that was just inserted.')
		}
		const fills: object[] = []
		let inserted = 0
		table.table.tableRows.forEach((row, r) => {
			row.tableCells?.forEach((cell, c) => {
				const index = cell.content?.[0]?.startIndex
				const text = el.cells[r]?.[c] ?? ''
				if (index === undefined || text === '') return
				fills.push({ insertText: { location: { index }, text } })
				inserted += text.length
			})
		})
		// Last cell first, so earlier cell indices stay valid as text goes in.
		fills.reverse()
		if (fills.length > 0) await docsBatchUpdate(http, file.id, fills)
		cursor = bodyEnd - 1 + inserted
	}
	await flushRun()
	return toOutput(file)
}

async function createSheet(
	http: DriveHttp,
	meta: { name: string; mimeType: string; parentFolderId?: string },
	values: string[][],
): Promise<WriteFileOutput> {
	const file = await mintEmptyFile(http, meta)
	const sheets = await googleJson<{ sheets?: Array<{ properties?: { sheetId?: number } }> }>(
		http,
		`${SHEETS_API}/spreadsheets/${encodeURIComponent(file.id)}?fields=sheets(properties(sheetId))`,
	)
	const sheetId = sheets.sheets?.[0]?.properties?.sheetId ?? 0
	await googleJson(http, `${SHEETS_API}/spreadsheets/${encodeURIComponent(file.id)}:batchUpdate`, {
		method: 'POST',
		body: { requests: sheetValuesRequests(sheetId, values) },
	})
	return toOutput(file)
}
