import { capturePosthogEvent } from '../../../../analytics/posthog'
import { createDefaultDriveClient } from '../client'
import {
	type DriveFileEntry,
	type DriveToolContext,
	FILE_FIELDS,
	clampPageSize,
	toFileEntry,
} from '../operations'
import { getGoogleDriveAccessToken } from '../token'

export const SEARCH_FILES_TOOL = 'google_drive__search_files'

const SEARCH_PAGE_SIZE_DEFAULT = 100
const SEARCH_PAGE_SIZE_MAX = 100

export interface SearchFilesInput {
	query: string
	pageSize?: number
	pageToken?: string
	orderBy?: string
	includeTrashed?: boolean
}

export interface SearchFilesOutput {
	files: DriveFileEntry[]
	nextPageToken?: string
}

export const SEARCH_FILES_DESCRIPTION =
	"Search the connected Google Drive with Drive's own query language, passed through unchanged. Shortcuts: fullText contains 'foo'; mimeType = 'application/vnd.google-apps.document'; '<folderId>' in parents; modifiedTime > '2026-01-01T00:00:00Z'. Trashed files are excluded unless includeTrashed is true. pageSize is capped at 100; pass nextPageToken back as pageToken for the next page. An empty query lists everything visible to the account."

/**
 * google_drive__search_files. The caller's query goes to Drive's `q` verbatim,
 * parenthesised only so the trashed filter we AND onto it cannot be skipped by an
 * `or` in the caller's expression.
 */
export async function searchFiles(
	ctx: DriveToolContext,
	input: SearchFilesInput,
): Promise<SearchFilesOutput> {
	const { accessToken } = await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId)
	const client = ctx.client ?? createDefaultDriveClient()

	const userQuery = input.query.trim()
	const includeTrashed = input.includeTrashed ?? false
	const clauses: string[] = []
	if (userQuery) clauses.push(`(${userQuery})`)
	if (!includeTrashed) clauses.push('trashed = false')

	const pageSize = clampPageSize(input.pageSize, SEARCH_PAGE_SIZE_DEFAULT, SEARCH_PAGE_SIZE_MAX)
	const res = await client.listFiles(accessToken, {
		q: clauses.join(' and '),
		pageSize,
		pageToken: input.pageToken,
		orderBy: input.orderBy,
		fields: `nextPageToken,files(${FILE_FIELDS})`,
	})

	const out: SearchFilesOutput = { files: (res.files ?? []).map(toFileEntry) }
	if (res.nextPageToken) out.nextPageToken = res.nextPageToken

	// Best-effort; counts and flags only, never the query text.
	void capturePosthogEvent('drive_search_ran', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		result_count: out.files.length,
		has_more: Boolean(out.nextPageToken),
		include_trashed: includeTrashed,
		page_size: pageSize,
	})
	return out
}
