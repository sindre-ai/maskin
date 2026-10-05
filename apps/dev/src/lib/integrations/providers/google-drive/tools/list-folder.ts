import { capturePosthogEvent } from '../../../../analytics/posthog'
import { type DriveApiFile, type DriveClient, createDefaultDriveClient } from '../client'
import {
	type DriveFileEntry,
	type DriveToolContext,
	FILE_FIELDS,
	GOOGLE_APPS_FOLDER_MIME,
	GOOGLE_APPS_SHORTCUT_MIME,
	clampPageSize,
	escapeDriveQueryValue,
	toFileEntry,
} from '../operations'
import { getGoogleDriveAccessToken } from '../token'

export const LIST_FOLDER_TOOL = 'google_drive__list_folder'

const LIST_PAGE_SIZE_DEFAULT = 100
const LIST_PAGE_SIZE_MAX = 1000
/** Recursive walk bounds: whichever is hit first ends the walk with truncated: true. */
export const RECURSIVE_MAX_FILES = 5000
export const RECURSIVE_MAX_DEPTH = 5

export interface ListFolderInput {
	folderId: string
	recursive?: boolean
	pageSize?: number
	pageToken?: string
}

export interface ListFolderOutput {
	files: DriveFileEntry[]
	nextPageToken?: string
	truncated?: boolean
}

export const LIST_FOLDER_DESCRIPTION =
	'List the files in a Google Drive folder (trashed files excluded). Non-recursive returns one page; pass nextPageToken back as pageToken for the next. With recursive true the walk is breadth-first on our side and stops at 5000 files or 5 levels deep, whichever comes first, returning truncated: true (nextPageToken is the last Drive page token seen). Shortcuts are listed with shortcutTargetId; a shortcut to a folder is followed once during a recursive walk, never twice, so shortcut loops end.'

function folderQuery(folderId: string): string {
	return `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`
}

export async function listFolder(
	ctx: DriveToolContext,
	input: ListFolderInput,
): Promise<ListFolderOutput> {
	const { accessToken } = await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId)
	const client = ctx.client ?? createDefaultDriveClient()
	const pageSize = clampPageSize(input.pageSize, LIST_PAGE_SIZE_DEFAULT, LIST_PAGE_SIZE_MAX)
	const recursive = input.recursive ?? false

	const out = recursive
		? await walkRecursive(client, accessToken, input.folderId, pageSize, input.pageToken)
		: await listOnePage(client, accessToken, input.folderId, pageSize, input.pageToken)

	// Best-effort; counts and flags only, never ids or names.
	void capturePosthogEvent('drive_folder_walked', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		recursive,
		file_count: out.files.length,
		truncated: out.truncated ?? false,
		has_more: Boolean(out.nextPageToken),
	})
	return out
}

async function listOnePage(
	client: DriveClient,
	accessToken: string,
	folderId: string,
	pageSize: number,
	pageToken: string | undefined,
): Promise<ListFolderOutput> {
	const res = await client.listFiles(accessToken, {
		q: folderQuery(folderId),
		pageSize,
		pageToken,
		fields: `nextPageToken,files(${FILE_FIELDS})`,
	})
	const out: ListFolderOutput = { files: (res.files ?? []).map(toFileEntry) }
	if (res.nextPageToken) out.nextPageToken = res.nextPageToken
	return out
}

/**
 * Breadth-first walk. Level 1 is the root folder's children; folders found at
 * level RECURSIVE_MAX_DEPTH are listed but not entered. A folder id is entered
 * at most once, so shortcut targets and shortcut cycles cannot loop the walk.
 * `pageToken`, when supplied, resumes the root folder's first listing.
 */
async function walkRecursive(
	client: DriveClient,
	accessToken: string,
	rootFolderId: string,
	pageSize: number,
	rootPageToken: string | undefined,
): Promise<ListFolderOutput> {
	const files: DriveFileEntry[] = []
	const entered = new Set<string>([rootFolderId])
	let queue: string[] = [rootFolderId]
	let lastPageToken: string | undefined
	let truncated = false

	for (let depth = 1; depth <= RECURSIVE_MAX_DEPTH && queue.length > 0 && !truncated; depth++) {
		const next: string[] = []
		for (const folderId of queue) {
			let pageToken = depth === 1 ? rootPageToken : undefined
			do {
				const res = await client.listFiles(accessToken, {
					q: folderQuery(folderId),
					pageSize,
					pageToken,
					fields: `nextPageToken,files(${FILE_FIELDS})`,
				})
				for (const f of res.files ?? []) {
					if (files.length >= RECURSIVE_MAX_FILES) {
						truncated = true
						break
					}
					files.push(toFileEntry(f))
					const descend = folderToEnter(f)
					if (descend && !entered.has(descend)) {
						entered.add(descend)
						next.push(descend)
					}
				}
				pageToken = res.nextPageToken
				if (pageToken) lastPageToken = pageToken
			} while (pageToken && !truncated)
			if (truncated) break
		}
		queue = next
	}

	// Folders discovered but never entered means the depth bound cut the walk short.
	if (queue.length > 0) truncated = true

	const out: ListFolderOutput = { files }
	if (truncated) {
		out.truncated = true
		if (lastPageToken) out.nextPageToken = lastPageToken
	}
	return out
}

/** The folder id to descend into for this entry, if any (a folder, or a shortcut to one). */
function folderToEnter(f: DriveApiFile): string | undefined {
	if (f.mimeType === GOOGLE_APPS_FOLDER_MIME) return f.id
	if (
		f.mimeType === GOOGLE_APPS_SHORTCUT_MIME &&
		f.shortcutDetails?.targetMimeType === GOOGLE_APPS_FOLDER_MIME
	) {
		return f.shortcutDetails.targetId
	}
	return undefined
}
