import type { Database } from '@maskin/db'
import { events, actors, orphanThreadDetections } from '@maskin/db/schema'
import { parseCommentDecision } from '@maskin/shared'
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { trackOrphanThreadDetected } from '../lib/analytics/orphan-thread-events'
import type { OrphanThreadKind } from '../lib/analytics/orphan-thread-events'
import { logger } from '../lib/logger'

const TICK_MS = 60 * 60 * 1000 // 1h
const REPLY_DEADLINE_MS = 24 * 60 * 60 * 1000 // 24h
// Only look back this far. Anything older than the cap is a historical thread
// that would swamp the first tick after a fresh deploy — the ledger starts
// empty so there's nothing to short-circuit the scan. Two weeks gives a
// generous grace on real dogfood use without pulling in years of history.
const SCAN_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000

interface RootCommentRow {
	id: number
	workspaceId: string
	actorId: string
	entityId: string
	createdAt: Date
	data: unknown
}

interface CommentData {
	content?: unknown
	mentions?: unknown
	parentEventId?: unknown
	metadata?: unknown
	decision?: unknown
}

/**
 * Background loop that fires the `orphan_thread_detected` PostHog event once
 * per @-mention comment that has gone 24h without a qualifying reply. Runs
 * hourly. Idempotent per root comment via the `orphan_thread_detections`
 * ledger's UNIQUE constraint on `root_comment_event_id`, so overlapping ticks
 * cannot double-fire the analytics signal.
 *
 * Reply requirement:
 * - Mentioned actor is an agent → only a reply from that agent satisfies.
 * - Mentioned actor is a human → any human reply satisfies (workspace humans
 *   are interchangeable for decision-blocking questions).
 *
 * `thread_kind` derived from comment shape:
 * - `data.decision` present → `decision_required`
 * - `?` in content → `question`
 * - otherwise → `flag`
 *
 * PostHog capture is best-effort (see `posthog.ts`). The ledger row is written
 * even if the capture is skipped/failing, so a decided thread is never
 * re-scanned. That trades one lost signal on outage against a re-fire storm
 * once PostHog recovers.
 */
export class OrphanThreadDetector {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private replyDeadlineMs: number = REPLY_DEADLINE_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 5 * 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const now = Date.now()
			const cutoff = new Date(now - this.replyDeadlineMs)
			const lookbackFloor = new Date(now - SCAN_LOOKBACK_MS)

			const candidates = await this.findCandidateRoots(cutoff, lookbackFloor)
			if (candidates.length === 0) return

			let fired = 0
			let skipped = 0

			for (const root of candidates) {
				const decided = await this.processRoot(root, now)
				if (decided === 'fired') fired++
				else skipped++
			}

			if (fired > 0 || skipped > 0) {
				logger.info('Orphan thread detector tick', {
					scanned: candidates.length,
					fired,
					skipped,
				})
			}
		} catch (err) {
			logger.error('Orphan thread detector tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private async findCandidateRoots(cutoff: Date, lookbackFloor: Date): Promise<RootCommentRow[]> {
		// Root @-mention comments (parentEventId absent, mentions non-empty)
		// older than the reply cutoff. `LEFT JOIN` the ledger and keep only the
		// unscanned rows — a decided thread must not fire again.
		const rows = await this.db
			.select({
				id: events.id,
				workspaceId: events.workspaceId,
				actorId: events.actorId,
				entityId: events.entityId,
				createdAt: events.createdAt,
				data: events.data,
			})
			.from(events)
			.leftJoin(orphanThreadDetections, eq(orphanThreadDetections.rootCommentEventId, events.id))
			.where(
				and(
					eq(events.action, 'commented'),
					eq(events.entityType, 'object'),
					lt(events.createdAt, cutoff),
					gt(events.createdAt, lookbackFloor),
					sql`jsonb_array_length(coalesce(${events.data}->'mentions', '[]'::jsonb)) > 0`,
					sql`(${events.data}->>'parentEventId') IS NULL`,
					isNull(orphanThreadDetections.id),
				),
			)

		return rows
			.filter((r): r is RootCommentRow => r.createdAt !== null)
			.map((r) => ({
				id: r.id,
				workspaceId: r.workspaceId,
				actorId: r.actorId,
				entityId: r.entityId,
				createdAt: r.createdAt as Date,
				data: r.data,
			}))
	}

	private async processRoot(root: RootCommentRow, now: number): Promise<'fired' | 'skipped'> {
		const data = (root.data ?? {}) as CommentData
		const mentions = normalizeMentions(data.mentions)
		if (mentions.length === 0) return 'skipped'

		const expectedActorId = mentions[0]
		if (!expectedActorId) return 'skipped'

		const [expectedActor] = await this.db
			.select({ id: actors.id, type: actors.type })
			.from(actors)
			.where(eq(actors.id, expectedActorId))
			.limit(1)

		if (!expectedActor) return 'skipped'

		if (await this.hasQualifyingReply(root, expectedActor)) return 'skipped'

		const threadKind = deriveThreadKind(data)
		const hoursWithoutReply = round2((now - root.createdAt.getTime()) / (60 * 60 * 1000))

		// Insert the ledger row first — if this races with another tick, the
		// UNIQUE(root_comment_event_id) constraint wins and we bail before
		// capture. Written even when capture fails so the thread is never
		// re-scanned.
		const inserted = await this.db
			.insert(orphanThreadDetections)
			.values({
				workspaceId: root.workspaceId,
				objectId: root.entityId,
				rootCommentEventId: root.id,
				expectedReplyActorId: expectedActor.id,
				hoursWithoutReply: hoursWithoutReply.toString(),
				threadKind,
			})
			.onConflictDoNothing({ target: orphanThreadDetections.rootCommentEventId })
			.returning({ id: orphanThreadDetections.id })

		if (inserted.length === 0) return 'skipped'

		try {
			await trackOrphanThreadDetected({
				workspaceId: root.workspaceId,
				objectId: root.entityId,
				rootCommentEventId: root.id,
				expectedReplyActorId: expectedActor.id,
				hoursWithoutReply,
				threadKind,
			})
		} catch (err) {
			logger.warn('trackOrphanThreadDetected failed', {
				rootCommentEventId: root.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		return 'fired'
	}

	private async hasQualifyingReply(
		root: RootCommentRow,
		expectedActor: { id: string; type: string },
	): Promise<boolean> {
		// Replies always attach directly to the root — the comment route
		// collapses reply-of-reply to the root via `resolveRootParentEventId`,
		// so a single depth-1 lookup catches every qualifying reply.
		const replies = await this.db
			.select({ actorId: events.actorId })
			.from(events)
			.where(
				and(
					eq(events.action, 'commented'),
					eq(events.entityType, 'object'),
					eq(events.entityId, root.entityId),
					sql`(${events.data}->>'parentEventId')::bigint = ${root.id}`,
				),
			)

		if (replies.length === 0) return false

		if (expectedActor.type === 'agent') {
			return replies.some((r) => r.actorId === expectedActor.id)
		}

		// Human mention: any human workspace-actor reply counts.
		const replierIds = Array.from(new Set(replies.map((r) => r.actorId)))
		if (replierIds.length === 0) return false
		const humans = await this.db
			.select({ id: actors.id })
			.from(actors)
			.where(and(inArray(actors.id, replierIds), eq(actors.type, 'human')))
		return humans.length > 0
	}
}

function normalizeMentions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	return raw.filter((m): m is string => typeof m === 'string' && m.length > 0)
}

function deriveThreadKind(data: CommentData): OrphanThreadKind {
	// A decision block is what makes a comment a decision. `metadata.chips` used
	// to be a second way to say the same thing; it is gone, and a comment that
	// still carries one is treated as the plain question or flag it reads as.
	// Parsed rather than duck-typed, so this agrees with the feed and the
	// timeline about what counts (see `parseCommentDecision`).
	if (parseCommentDecision(data.decision)) return 'decision_required'
	if (typeof data.content === 'string' && data.content.includes('?')) return 'question'
	return 'flag'
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}
