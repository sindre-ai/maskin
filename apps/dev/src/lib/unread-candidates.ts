import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { and, eq, gt, max, ne, sql } from 'drizzle-orm'
import { createTtlCache } from './ttl-cache'

/**
 * Past this many candidate entities the narrowing is skipped and the unread query runs over every
 * subscription, as it did before. Keeps the id list well under the driver's parameter limit and
 * keeps one person's cached list small.
 */
export const MAX_UNREAD_CANDIDATE_ENTITIES = 5_000

/** How long a scan of every mention is trusted before it is read again from the start. */
const FULL_SCAN_TTL_MS = 10 * 60_000

/** Cached people. Each holds at most MAX_UNREAD_CANDIDATE_ENTITIES ids. */
const MAX_CACHED_ACTORS = 300

/**
 * Between two polls the scan only looks at comments newer than the last one it saw, minus this
 * many ids. An id is handed out when a write starts and is only visible once it commits, so a
 * comment slightly older than the newest one seen can still turn up later; this covers that.
 */
const REPLAY_EVENT_IDS = 10_000

interface MentionScan {
	entityIds: Set<string>
	/** The newest event id that existed when the scan started. */
	seenUpTo: number
}

const scans = createTtlCache<MentionScan>({
	ttlMs: FULL_SCAN_TTL_MS,
	maxEntries: MAX_CACHED_ACTORS,
})

/** For tests, so one test's scan never answers the next one. */
export function _resetUnreadCandidateCache(): void {
	scans.invalidate()
}

async function newestEventId(db: Database): Promise<number> {
	const [row] = await db.select({ id: max(events.id) }).from(events)
	return row?.id ?? 0
}

/** Entities with a comment, by someone else, that mentions the actor. `afterId` skips older ones. */
async function mentionedEntityIds(
	db: Database,
	workspaceId: string,
	actorId: string,
	afterId?: number,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ entityId: events.entityId })
		.from(events)
		.where(
			and(
				...(afterId === undefined ? [] : [gt(events.id, afterId)]),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
				ne(events.actorId, actorId),
				sql`${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)`,
			),
		)
	return rows.map((r) => r.entityId)
}

/**
 * Every entity with a mentioning comment. The first read for a person scans all of their mentions
 * (the mentions index finds them in milliseconds, but the table reads behind it took 3 s cold for
 * 5,000 comments). After that it keeps the list and only looks at what was written since, so the
 * answer is the same as a full scan, found without rereading the old comments. A comment's
 * mentions are fixed when it is written (an edit keeps them), so an entity never needs removing;
 * the list is rebuilt every FULL_SCAN_TTL_MS to drop ones that no longer matter.
 *
 * In-process, like the other caches here: production runs one API process. A second process would
 * keep its own list and stay correct, it just scans once itself.
 */
async function mentionedEntities(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<Set<string> | null> {
	const key = `${workspaceId}:${actorId}`
	const scan = await scans.get(key, async () => {
		// Read before scanning, so a comment written during the scan is seen by the next poll.
		const seenUpTo = await newestEventId(db)
		return { entityIds: new Set(await mentionedEntityIds(db, workspaceId, actorId)), seenUpTo }
	})

	const seenUpTo = await newestEventId(db)
	const fresh = await mentionedEntityIds(
		db,
		workspaceId,
		actorId,
		Math.max(0, scan.seenUpTo - REPLAY_EVENT_IDS),
	)
	for (const id of fresh) scan.entityIds.add(id)
	scan.seenUpTo = Math.max(scan.seenUpTo, seenUpTo)

	if (scan.entityIds.size > MAX_UNREAD_CANDIDATE_ENTITIES) {
		scans.invalidate(key)
		return null
	}
	return scan.entityIds
}

/**
 * The entities that can have an unread item for this actor at all: those with a comment that
 * mentions them, and the workspace's onboarding coach threads (which count without a mention).
 * Both are cheap to list, whereas the aggregate in GET /api/subscriptions/unread probes `events`
 * and `read_state` once per subscription, which cost 500 ms for a person with 2,800 subscriptions
 * when only one of them had anything unread. Null means the list was too long to be worth passing
 * on.
 */
export async function unreadCandidateEntityIds(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<string[] | null> {
	const [mentioned, onboarding] = await Promise.all([
		mentionedEntities(db, workspaceId, actorId),
		db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'onboarding_session'))),
	])
	if (mentioned === null) return null
	const ids = new Set([...mentioned, ...onboarding.map((r) => r.id)])
	return ids.size > MAX_UNREAD_CANDIDATE_ENTITIES ? null : [...ids]
}
