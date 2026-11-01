import type { Database } from '@maskin/db'
import { events, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND, parseCommentDecision, parseForYouMetadata } from '@maskin/shared'
import { and, eq, gt, inArray, lte, max, sql } from 'drizzle-orm'
import { TERMINAL_STATUSES } from '../services/session-lifecycle'

/**
 * Object statuses after which an ask about the object no longer needs anyone.
 * Workspace statuses are configurable, so this is the union of the closed
 * states the built-in object types use.
 */
export const CLOSED_OBJECT_STATUSES = [
	'done',
	'completed',
	'succeeded',
	'failed',
	'cancelled',
	'canceled',
	'closed',
	'archived',
	'shipped',
	'dismissed',
	// The workspace task status for work that was dropped. An agent that discards the task a
	// card was about must not leave the card behind.
	'discarded',
	'rejected',
]

/**
 * Ids of the decision comments among `comments` whose drafts have all been dealt with: every
 * draft names an object, and every one of those objects is closed (sent and done, skipped or
 * discarded). Sending or skipping a draft closes its task, never the card, so without this a
 * card stays on For You after its last message has gone. A card with no drafts, a draft that is
 * only text or a file, or one task still open is not finished.
 */
export async function findFinishedDraftCards(
	db: Database,
	workspaceId: string,
	comments: Array<typeof events.$inferSelect>,
): Promise<Set<number>> {
	const draftIdsByComment = new Map<number, string[] | null>()
	for (const comment of comments) {
		const data = (comment.data ?? {}) as Record<string, unknown>
		const decision = parseCommentDecision(data.decision)
		const drafts = [...(decision?.draft ? [decision.draft] : []), ...(decision?.drafts ?? [])]
		if (drafts.length === 0) continue
		draftIdsByComment.set(
			Number(comment.id),
			drafts.every((d) => d.object_id) ? drafts.map((d) => d.object_id as string) : null,
		)
	}
	const draftObjectIds = [...new Set([...draftIdsByComment.values()].flatMap((ids) => ids ?? []))]
	if (draftObjectIds.length === 0) return new Set()

	const rows = await db
		.select({ id: objects.id, status: objects.status })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, draftObjectIds)))
	const closed = new Set(
		rows.filter((o) => CLOSED_OBJECT_STATUSES.includes(o.status ?? '')).map((o) => o.id),
	)
	const finished = new Set<number>()
	for (const [commentId, ids] of draftIdsByComment) {
		if (ids?.every((id) => closed.has(id))) finished.add(commentId)
	}
	return finished
}

/** Whether a comment asks the person for a call: a decision block, which is also where drafts live. */
function carriesDecision(comment: typeof events.$inferSelect | undefined): boolean {
	const data = (comment?.data ?? {}) as Record<string, unknown>
	return parseCommentDecision(data.decision) !== null
}

export type ForYouCard = {
	row: typeof notifications.$inferSelect
	meta: NonNullable<ReturnType<typeof parseForYouMetadata>>
}

export type VisibleForYou = {
	/** Cards that are still live, in the order the For You list shows them. */
	cards: ForYouCard[]
	objectById: Map<string, typeof objects.$inferSelect>
	sourceById: Map<number, typeof events.$inferSelect>
	/** Newest event on each object a source-less card names; what reading it moves the position to. */
	newestEventByEntity: Map<string, number>
}

/**
 * The For You cards `GET /api/for-you` shows for one actor in one workspace: pending/seen
 * `needs_input` rows of kind FOR_YOU_KIND, minus the ones whose session ended (unless the card asks for an approval or carries a draft), whose object is
 * closed or moved on, or that the viewer already read or answered. Shared with the briefing and
 * lifecycle pushes so a push never counts something the app does not show.
 */
export async function loadVisibleForYou(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<VisibleForYou> {
	const rows = await db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.workspaceId, workspaceId),
				eq(notifications.targetActorId, actorId),
				eq(notifications.type, 'needs_input'),
				inArray(notifications.status, ['pending', 'seen']),
				sql`${notifications.metadata}->>'kind' = ${FOR_YOU_KIND}`,
			),
		)

	const candidates = rows.flatMap((row) => {
		const meta = parseForYouMetadata(row.metadata)
		return meta ? [{ row, meta }] : []
	})
	if (candidates.length === 0) {
		return {
			cards: [],
			objectById: new Map(),
			sourceById: new Map(),
			newestEventByEntity: new Map(),
		}
	}

	const objectIds = [
		...new Set(candidates.flatMap((x) => (x.row.objectId ? [x.row.objectId] : []))),
	]
	const sessionIds = [
		...new Set(candidates.flatMap((x) => (x.row.sessionId ? [x.row.sessionId] : []))),
	]

	const [objectRows, sessionRows, readRows] = await Promise.all([
		objectIds.length
			? db
					.select()
					.from(objects)
					.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
			: [],
		sessionIds.length
			? db
					.select({ id: sessions.id, status: sessions.status })
					.from(sessions)
					.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.id, sessionIds)))
			: [],
		objectIds.length
			? db
					.select({ entityId: readState.entityId, lastReadEventId: readState.lastReadEventId })
					.from(readState)
					.where(
						and(
							eq(readState.workspaceId, workspaceId),
							eq(readState.actorId, actorId),
							eq(readState.entityType, 'object'),
							inArray(readState.entityId, objectIds),
						),
					)
			: [],
	])
	const objectById = new Map(objectRows.map((o) => [o.id, o]))
	const sessionStatusById = new Map(sessionRows.map((s) => [s.id, s.status]))
	const lastReadByEntity = new Map(readRows.map((r) => [r.entityId, r.lastReadEventId]))

	// Source comments, and any reply by the viewer after them, in two queries.
	const sourceIds = candidates.flatMap((x) =>
		x.meta.source_comment_id !== undefined ? [x.meta.source_comment_id] : [],
	)
	const sourceRows = sourceIds.length
		? await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), inArray(events.id, sourceIds)))
		: []
	const sourceById = new Map(sourceRows.map((e) => [e.id, e]))
	const finishedDraftCards = await findFinishedDraftCards(db, workspaceId, sourceRows)

	const replyRows = objectIds.length
		? await db
				.select({ entityId: events.entityId, id: events.id })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.action, 'commented'),
						eq(events.actorId, actorId),
						inArray(events.entityId, objectIds),
						gt(events.id, Math.min(...sourceIds, Number.MAX_SAFE_INTEGER)),
					),
				)
		: []

	// A curated item with no source comment cannot be retired by answering a comment. It
	// counts as handled once the person has read its object past everything that existed
	// when the Chief of Staff listed it; later activity does not bring it back.
	const noSource = candidates.filter(
		({ row, meta }) => row.objectId && meta.source_comment_id === undefined,
	)
	const baselineByNotification = new Map<string, number>()
	await Promise.all(
		noSource.map(async ({ row }) => {
			const [found] = await db
				.select({ id: max(events.id) })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityId, row.objectId as string),
						row.createdAt ? lte(events.createdAt, row.createdAt) : undefined,
					),
				)
			baselineByNotification.set(row.id, Number(found?.id ?? 0))
		}),
	)
	const newestEventByEntity = new Map<string, number>()
	if (noSource.length > 0) {
		const newest = await db
			.select({ entityId: events.entityId, id: max(events.id) })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					inArray(
						events.entityId,
						noSource.map(({ row }) => row.objectId as string),
					),
				),
			)
			.groupBy(events.entityId)
		for (const r of newest) newestEventByEntity.set(r.entityId, Number(r.id ?? 0))
	}

	const cards = candidates
		.filter(({ row, meta }) => {
			const sessionStatus = row.sessionId ? sessionStatusById.get(row.sessionId) : undefined
			if (sessionStatus && (TERMINAL_STATUSES as readonly string[]).includes(sessionStatus)) {
				// An ended session has nobody left to answer a question, but a card that asks for
				// an approval or carries a draft is still the person's to act on.
				const source =
					meta.source_comment_id !== undefined ? sourceById.get(meta.source_comment_id) : undefined
				if (!carriesDecision(source)) return false
			}
			// Every message the card offered has been sent or skipped: nothing left to approve.
			if (meta.source_comment_id !== undefined && finishedDraftCards.has(meta.source_comment_id)) {
				return false
			}
			if (row.objectId) {
				const obj = objectById.get(row.objectId)
				// Deleted (FK set null would have cleared it) or closed: nothing left to decide.
				if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
				// The ask names the state it assumed ("move to active" assumes "proposed").
				// Once the object is anywhere else, the ask is already moot.
				if (meta.only_while_status && !meta.only_while_status.includes(obj.status ?? '')) {
					return false
				}
				const sourceId = meta.source_comment_id
				if (sourceId !== undefined) {
					const lastRead = lastReadByEntity.get(row.objectId) ?? 0
					if (lastRead >= sourceId) return false
					if (replyRows.some((r) => r.entityId === row.objectId && r.id > sourceId)) return false
				} else {
					const baseline = baselineByNotification.get(row.id) ?? 0
					const lastRead = lastReadByEntity.get(row.objectId) ?? 0
					if (baseline > 0 && lastRead >= baseline) return false
				}
			}
			return true
		})
		.sort(
			(a, b) =>
				a.meta.rank - b.meta.rank ||
				(b.row.createdAt?.getTime() ?? 0) - (a.row.createdAt?.getTime() ?? 0),
		)

	return { cards, objectById, sourceById, newestEventByEntity }
}
