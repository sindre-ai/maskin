import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvents } from '../../../events/record-event'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import { type DriveChange, type DriveClient, createDefaultDriveClient } from './client'
import { isDriveError } from './errors'
import { GOOGLE_DRIVE_PROVIDER } from './token'
import type { DriveEventType, DriveIntegrationConfig, WatchedFolderEntry } from './watch'

/** Entity type of the signals this fan-out emits; actions are the four DriveEventTypes. */
export const DRIVE_FILE_ENTITY = 'google_drive.file'

const PAGE_SIZE = 100
/** Pages one run walks before it stops and leaves the rest to the next delivery. */
const MAX_PAGES_PER_RUN = 50
/** Levels of ancestors checked against the watched folders. */
const ANCESTRY_MAX_DEPTH = 25
const PARENT_CACHE_TTL_MS = 5 * 60 * 1000
const PARENT_CACHE_MAX_ENTRIES = 5000
/** A change this close to the file's creation time is reported as created. */
const CREATED_WINDOW_MS = 60 * 1000

/**
 * In-process fileId -> parents cache (5 minutes). Keyed by integration as well
 * as file so one account's view of a file's parents is never served to another.
 * It also gives deletions an ancestry: Drive reports a permanently deleted file
 * as removed with no metadata, and files.get on it is a 404.
 */
const parentCache = new Map<string, { parents: string[]; at: number }>()

export function clearDriveParentCache(): void {
	parentCache.clear()
}

function cacheKey(integrationId: string, fileId: string): string {
	return `${integrationId}:${fileId}`
}

function cacheGet(integrationId: string, fileId: string): string[] | undefined {
	const hit = parentCache.get(cacheKey(integrationId, fileId))
	if (!hit) return undefined
	if (Date.now() - hit.at > PARENT_CACHE_TTL_MS) {
		parentCache.delete(cacheKey(integrationId, fileId))
		return undefined
	}
	return hit.parents
}

function cacheSet(integrationId: string, fileId: string, parents: string[]): void {
	if (parentCache.size >= PARENT_CACHE_MAX_ENTRIES) parentCache.clear()
	parentCache.set(cacheKey(integrationId, fileId), { parents, at: Date.now() })
}

export interface ClassifiedChange {
	fileId: string
	eventType: DriveEventType
	changeTime: string
	name?: string
	mimeType?: string
}

/**
 * Turn one Drive change into the event it represents, or null when it is not a
 * file change (shared-drive metadata). Drive does not distinguish create from
 * edit, so a change within a minute of the file's creation time reads as created.
 */
export function classifyChange(change: DriveChange): ClassifiedChange | null {
	const fileId = change.fileId ?? change.file?.id
	if (!fileId) return null
	const file = change.file
	const changeTime = change.time ?? new Date().toISOString()
	const base = {
		fileId,
		changeTime,
		...(file?.name !== undefined ? { name: file.name } : {}),
		...(file?.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
	}
	if (change.removed) return { ...base, eventType: 'deleted' }
	if (!file) return null
	if (file.trashed) return { ...base, eventType: 'trashed' }
	const created = file.createdTime ? Date.parse(file.createdTime) : Number.NaN
	const at = Date.parse(changeTime)
	const isCreate =
		Number.isFinite(created) && Number.isFinite(at) && at - created <= CREATED_WINDOW_MS
	return { ...base, eventType: isCreate ? 'created' : 'updated' }
}

/**
 * Watched folders that are an ancestor of a file with these parents. Walks up
 * level by level (breadth-first, so a file under two parents is covered), keeps
 * going past a match so nested watched folders each match, and stops at the
 * root, a loop, or ANCESTRY_MAX_DEPTH.
 */
export async function matchWatchedAncestors(
	startParents: string[],
	watched: Set<string>,
	parentsOf: (folderId: string) => Promise<string[]>,
): Promise<Set<string>> {
	const matched = new Set<string>()
	const seen = new Set<string>()
	let frontier = startParents
	for (let depth = 0; depth < ANCESTRY_MAX_DEPTH && frontier.length > 0; depth++) {
		const next: string[] = []
		for (const id of frontier) {
			if (seen.has(id)) continue
			seen.add(id)
			if (watched.has(id)) matched.add(id)
			next.push(...(await parentsOf(id)))
		}
		frontier = next
	}
	return matched
}

class CursorMovedError extends Error {
	constructor() {
		super('config.drive.startPageToken moved under this fan-out')
		this.name = 'CursorMovedError'
	}
}

interface PageCommit {
	integrationId: string
	/** The cursor this page was read from; the write only lands if the row still holds it. */
	cursor: string
	next: string
	eventRows: Array<Parameters<typeof recordEvents>[1][number]>
	firedFolderIds: string[]
}

/**
 * Persist one page: advance config.drive.startPageToken, stamp lastFiredAt on
 * the folders that fired, and insert the events, in one transaction.
 *
 * The cursor write is compare-and-set. Two deliveries (or a delivery and the
 * daily poll) can read the same cursor; the loser's UPDATE finds a different
 * value, matches no row and rolls its events back, so a change is emitted once.
 *
 * lastFiredAt is written inside that same UPDATE, by folder id, from the row's
 * current watchedFolders. It never writes back an array read earlier, so a watch
 * stopped while the fan-out ran stays stopped.
 */
async function commitPage(db: Database, page: PageCommit): Promise<void> {
	await db.transaction(async (tx) => {
		const withCursor = sql`jsonb_set(${integrations.config}, '{drive,startPageToken}', to_jsonb(${page.next}::text), true)`
		const firedJson = JSON.stringify(page.firedFolderIds)
		const nowIso = new Date().toISOString()
		const config =
			page.firedFolderIds.length === 0
				? withCursor
				: sql`jsonb_set(${withCursor}, '{drive,watchedFolders}', COALESCE((SELECT jsonb_agg(CASE WHEN entry->>'folderId' IN (SELECT jsonb_array_elements_text(${firedJson}::jsonb)) THEN entry || jsonb_build_object('lastFiredAt', ${nowIso}::text) ELSE entry END ORDER BY ord) FROM jsonb_array_elements(integrations.config->'drive'->'watchedFolders') WITH ORDINALITY AS t(entry, ord)), '[]'::jsonb), false)`
		const moved = await tx
			.update(integrations)
			.set({ config, updatedAt: new Date() })
			.where(
				and(
					eq(integrations.id, page.integrationId),
					sql`${integrations.config}->'drive'->>'startPageToken' = ${page.cursor}`,
				),
			)
			.returning({ id: integrations.id })
		if (moved.length === 0) throw new CursorMovedError()
		await recordEvents(tx, page.eventRows)
	})
}

export interface FanOutResult {
	emitted: number
	pages: number
}

/**
 * Read the account's change feed from the row's cursor and emit one
 * google_drive.file signal per change inside a watched folder or any descendant.
 * Shared by the webhook route and the daily fallback poll, so both emit the same
 * signals.
 *
 * Per page: resolve each change's ancestry (the change's own parents, else the
 * 5 minute cache, else files.get), match it against the watched folders, then
 * commit the page's events together with the cursor advance. A page that fails
 * leaves the cursor where it was, so the next run retries it.
 *
 * With no watched folders nothing can match, so the cursor is moved to "now"
 * instead of walking the feed; a folder watched later then starts from then,
 * not from an old backlog.
 */
export async function runDriveFanOut(
	db: Database,
	integrationId: string,
	opts: { client?: DriveClient } = {},
): Promise<FanOutResult> {
	const result: FanOutResult = { emitted: 0, pages: 0 }
	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, integrationId),
				eq(integrations.provider, GOOGLE_DRIVE_PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!row) return result

	const config = row.config as DriveIntegrationConfig | null
	const drive = config?.drive
	if (!drive?.startPageToken) {
		logger.warn('Google Drive fan-out skipped: no startPageToken on the row', { integrationId })
		return result
	}
	const systemActorId = config?.system_actor_id
	if (!systemActorId) {
		logger.warn('Google Drive fan-out skipped: no system_actor_id on the row', { integrationId })
		return result
	}

	const client = opts.client ?? createDefaultDriveClient()
	const accessToken = await new TokenManager().getValidToken(
		db,
		integrationId,
		getProvider(GOOGLE_DRIVE_PROVIDER),
	)

	const watchedFolders: WatchedFolderEntry[] = drive.watchedFolders ?? []
	let cursor = drive.startPageToken

	try {
		if (watchedFolders.length === 0) {
			const fresh = await client.getStartPageToken(accessToken)
			if (fresh !== cursor) {
				await commitPage(db, {
					integrationId,
					cursor,
					next: fresh,
					eventRows: [],
					firedFolderIds: [],
				})
			}
			return result
		}

		const watched = new Set(watchedFolders.map((w) => w.folderId))
		const entryById = new Map(watchedFolders.map((w) => [w.folderId, w]))

		const parentsOf = async (folderId: string): Promise<string[]> => {
			const cached = cacheGet(integrationId, folderId)
			if (cached) return cached
			let parents: string[] = []
			try {
				parents = (await client.getFile(accessToken, folderId, 'id,parents')).parents ?? []
			} catch (err) {
				// Not visible to the account: it has no ancestry we can follow.
				if (!(isDriveError(err) && ['FILE_NOT_FOUND', 'PERMISSION_DENIED'].includes(err.code))) {
					throw err
				}
			}
			cacheSet(integrationId, folderId, parents)
			return parents
		}

		for (let pageNo = 0; pageNo < MAX_PAGES_PER_RUN; pageNo++) {
			const page = await client.listChanges(accessToken, {
				pageToken: cursor,
				pageSize: PAGE_SIZE,
			})
			const next = page.nextPageToken ?? page.newStartPageToken
			if (!next) break

			const eventRows: PageCommit['eventRows'] = []
			const fired = new Set<string>()
			for (const change of page.changes ?? []) {
				const classified = classifyChange(change)
				if (!classified) continue

				// Ancestry: the change's own parents, else the cache. A removed file has no
				// metadata and files.get on it is a 404, so for removals the cache is all
				// there is; any other change without parents asks Drive.
				const ownParents = change.file?.parents
				if (ownParents) cacheSet(integrationId, classified.fileId, ownParents)
				const parents =
					ownParents ??
					(classified.eventType === 'deleted'
						? cacheGet(integrationId, classified.fileId)
						: await parentsOf(classified.fileId))
				if (!parents || parents.length === 0) continue

				const matched = await matchWatchedAncestors(parents, watched, parentsOf)
				for (const folderId of matched) {
					const allowed = entryById.get(folderId)?.eventTypes
					if (allowed && !allowed.includes(classified.eventType)) continue
					fired.add(folderId)
					eventRows.push({
						workspaceId: row.workspaceId,
						actorId: systemActorId,
						action: classified.eventType,
						entityType: DRIVE_FILE_ENTITY,
						entityId: integrationId,
						data: {
							fileId: classified.fileId,
							folderId,
							eventType: classified.eventType,
							changeTime: classified.changeTime,
							...(classified.name !== undefined ? { name: classified.name } : {}),
							...(classified.mimeType !== undefined ? { mimeType: classified.mimeType } : {}),
						},
					})
				}
			}

			// Nothing changed and the cursor did not move: no write.
			if (eventRows.length > 0 || next !== cursor) {
				await commitPage(db, {
					integrationId,
					cursor,
					next,
					eventRows,
					firedFolderIds: [...fired],
				})
			}
			result.emitted += eventRows.length
			result.pages += 1
			if (!page.nextPageToken) break
			cursor = next
		}
	} catch (err) {
		if (err instanceof CursorMovedError) {
			// Another delivery or the poll advanced the cursor first and emitted these changes.
			logger.info('Google Drive fan-out yielded to a concurrent run', { integrationId })
			return result
		}
		throw err
	}
	return result
}
