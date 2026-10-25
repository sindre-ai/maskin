import { integrations } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../../../../analytics/posthog'
import { logger } from '../../../../logger'
import { type DriveClient, createDefaultDriveClient } from '../client'
import { DriveError } from '../errors'
import { type DriveToolContext, GOOGLE_APPS_FOLDER_MIME } from '../operations'
import { getGoogleDriveAccessToken } from '../token'
import {
	DRIVE_EVENT_TYPES,
	type DriveEventType,
	type DriveIntegrationConfig,
	type WatchedFolderEntry,
	hasLiveChannel,
	renewDriveWatch,
} from '../watch'

export const WATCH_FOLDER_TOOL = 'google_drive__watch_folder'

/** Watched folders per workspace: keeps the parent-chain filter cheap. */
export const MAX_WATCHED_FOLDERS = 20
/** Ancestor names kept in a watch's path. */
const PATH_MAX_ANCESTORS = 5

export interface WatchFolderInput {
	folderId: string
	eventTypes?: DriveEventType[]
}

export interface WatchFolderOutput {
	ok: true
	watchedFolders: WatchedFolderEntry[]
}

export const WATCH_FOLDER_DESCRIPTION =
	'Watch a Google Drive folder. From then on a google_drive.file signal (action created, updated, deleted or trashed) fires for files in the folder and in any of its subfolders, and can drive triggers; filter a trigger on the folderId in the signal. Drive cannot watch descendants natively, so Maskin follows the account change feed and checks each change against the watched folders. Optional eventTypes limits which of the four actions fire (default all four). Watching a folder that is already watched changes nothing. At most 20 folders per workspace. A permanently deleted file fires deleted only if Maskin saw that file change in the last 5 minutes; trashing is always reported. Returns { ok: true, watchedFolders } listing every watch in the workspace.'

type DriveRow = Pick<typeof integrations.$inferSelect, 'id' | 'config'>

function entriesOf(row: DriveRow): WatchedFolderEntry[] {
	const raw = (row.config as DriveIntegrationConfig | null)?.drive?.watchedFolders
	return Array.isArray(raw) ? raw : []
}

async function loadWorkspaceDriveRows(ctx: DriveToolContext): Promise<DriveRow[]> {
	return ctx.db
		.select({ id: integrations.id, config: integrations.config })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, ctx.workspaceId),
				eq(integrations.provider, 'google-drive'),
				inArray(integrations.status, ['active', 'error']),
			),
		)
}

/** Ancestor names nearest-last, up to PATH_MAX_ANCESTORS. Best effort: stops at the first miss. */
async function ancestorPath(
	client: DriveClient,
	accessToken: string,
	parents: string[] | undefined,
): Promise<string | undefined> {
	const names: string[] = []
	let next = parents?.[0]
	for (let i = 0; i < PATH_MAX_ANCESTORS && next; i++) {
		try {
			const parent = await client.getFile(accessToken, next, 'id,name,parents')
			names.unshift(parent.name)
			next = parent.parents?.[0]
		} catch {
			break
		}
	}
	return names.length > 0 ? names.join('/') : undefined
}

export async function watchFolder(
	ctx: DriveToolContext,
	input: WatchFolderInput,
): Promise<WatchFolderOutput> {
	const { accessToken, integrationId } = await getGoogleDriveAccessToken(
		ctx.db,
		ctx.workspaceId,
		ctx.actorId,
	)
	const client = ctx.client ?? createDefaultDriveClient()

	const rows = await loadWorkspaceDriveRows(ctx)
	const current = rows.flatMap(entriesOf)
	if (current.some((w) => w.folderId === input.folderId)) {
		return { ok: true, watchedFolders: current }
	}
	if (current.length >= MAX_WATCHED_FOLDERS) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message: `This workspace already watches ${MAX_WATCHED_FOLDERS} folders, the maximum.`,
			hint: 'Stop watching a folder before adding another.',
		})
	}

	const folder = await client.getFile(
		accessToken,
		input.folderId,
		'id,name,mimeType,parents,trashed',
	)
	if (folder.mimeType !== GOOGLE_APPS_FOLDER_MIME) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message: 'The id is not a folder. Only folders can be watched.',
		})
	}
	if (folder.trashed) {
		throw new DriveError({ code: 'FILE_TRASHED', message: 'The folder is in the trash.' })
	}

	// The row needs a live channel for pushes to arrive at all; repair it when it
	// lapsed. A failed repair does not block the watch: the daily poll still
	// emits the signals and the renewer retries the channel.
	const target = rows.find((r) => r.id === integrationId)
	const drive = (target?.config as DriveIntegrationConfig | null)?.drive
	if (!hasLiveChannel(drive)) {
		try {
			await renewDriveWatch(ctx.db, integrationId, client)
		} catch (err) {
			logger.warn('Drive watch_folder could not repair the channel', {
				integrationId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const path = await ancestorPath(client, accessToken, folder.parents)
	const entry: WatchedFolderEntry = {
		folderId: folder.id,
		name: folder.name,
		...(path ? { path } : {}),
		addedAt: new Date().toISOString(),
		...(input.eventTypes && input.eventTypes.length > 0
			? { eventTypes: DRIVE_EVENT_TYPES.filter((t) => input.eventTypes?.includes(t)) }
			: {}),
	}

	// One UPDATE appends to the row's current array, and only when the folder is
	// not already in it, so a concurrent add or stop is never overwritten.
	const entryArray = JSON.stringify([entry])
	const folderMatch = JSON.stringify([{ folderId: entry.folderId }])
	await ctx.db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{drive}', COALESCE(${integrations.config}->'drive', '{}'::jsonb) || jsonb_build_object('watchedFolders', COALESCE(${integrations.config}->'drive'->'watchedFolders', '[]'::jsonb) || ${entryArray}::jsonb), true)`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(integrations.id, integrationId),
				sql`NOT (COALESCE(${integrations.config}->'drive'->'watchedFolders', '[]'::jsonb) @> ${folderMatch}::jsonb)`,
			),
		)

	const watchedFolders = (await loadWorkspaceDriveRows(ctx)).flatMap(entriesOf)

	// Best-effort; counts and flags only, never ids or names.
	void capturePosthogEvent('drive_folder_watched', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		watched_count: watchedFolders.length,
		event_types_limited: entry.eventTypes !== undefined,
	})
	return { ok: true, watchedFolders }
}
