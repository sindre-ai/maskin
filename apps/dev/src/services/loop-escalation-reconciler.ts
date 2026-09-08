import type { Database } from '@maskin/db'
import { events, actors, objects, relationships, triggers } from '@maskin/db/schema'
import { isWaitingOnViewer } from '@maskin/shared'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { postComment } from '../lib/comments'
import { FLAGS, type FeatureFlagConfig, getFeatureFlagConfig } from '../lib/feature-flags'
import { logger } from '../lib/logger'

/**
 * D6b — Loops v4 escalation reconciler.
 *
 * Scans every enabled trigger (a trigger IS the `loop_step` row on this stack
 * — see the D6a migration for the ADR-005 note) whose escalation triple is
 * set (`hands_off_to_actor_id`, `escalates_to_actor_id`, `escalate_after_ms`),
 * derives the shared `waitingOnViewer` predicate for the hands-off actor from
 * unread events on the parent loop's child objects (same expression the
 * loops-list route uses in `apps/dev/src/routes/loops.ts`), and — if the
 * hands-off actor has been "waiting" longer than `escalate_after_ms` — posts
 * ONE attention-4 comment on the parent loop mentioning the escalates-to
 * actor, then stamps `triggers.last_escalated_at` so the next tick does not
 * double-post.
 *
 * Rationale for the shape:
 *
 * - **Same predicate as D3 banner.** Imports `isWaitingOnViewer` from
 *   `packages/shared/src/loops/waiting-on-viewer.ts` so the reconciler cannot
 *   drift from what the frontend banner treats as "stalled" (Task 1 delivered
 *   the shared module; the SPEC lists that shared-symbol contract as
 *   load-bearing so the two sites never disagree on what "stalled" means).
 *
 * - **Idempotency via a per-wait-spell cursor**, not a per-tick lock. If the
 *   most recent unread event predates `last_escalated_at`, this wait spell
 *   has already been escalated and the tick skips. If a fresh unread event
 *   lands after the last escalation, that's a NEW wait spell and escalation
 *   re-arms on its own — no cursor reset needed. A per-tick lock would either
 *   flap escalations on every tick or never re-arm at all; per-wait-spell
 *   sits between those and matches the SPEC ("same step + same threshold
 *   must not double-post" is inherently a per-wait-spell rule).
 *
 * - **Global env gate for rollback.** The reconciler runs iff BOTH
 *   `loops-v4-polish` AND `loops-v4-polish.step_flow` are present in
 *   `FF_TESTER_FEATURES`. That gives Ops the same one-env-flip revert
 *   `.claude/rules/feature-flags.md` guarantees for frontend deltas, only
 *   applied at the backend cron boundary. The bet's SPEC explicitly opts the
 *   reconciler into feature-flag rollback ("per-delta sub-flags let a single
 *   delta be reverted without dropping the rest") — this is the shape that
 *   makes it work for a backend cron.
 *
 * - **Cadence** — `TICK_MS` sits at 60s, roughly one tenth of the smallest
 *   realistic `escalate_after_ms` a human would configure (a few minutes for
 *   an urgent hand-off; hours for a typical one). The webhook-deliveries
 *   reconciler ticks at 5 min for a fan-out that budgets ~15 min; escalation
 *   is more time-sensitive, so 1 min buys tighter latency without appreciable
 *   load — the SELECT is filtered on three IS NOT NULL columns and only fires
 *   for the small subset of steps that opt in.
 */

const TICK_MS = 60_000

/**
 * Startup delay so a fresh boot doesn't tick concurrently with migrations or
 * PG NOTIFY bridge startup — mirrors `WebhookDeliveriesReconciler`.
 */
const START_DELAY_MS = 60_000

interface CandidateStep {
	triggerId: string
	triggerName: string
	workspaceId: string
	targetActorId: string
	handsOffToActorId: string
	escalatesToActorId: string
	escalateAfterMs: number
	lastEscalatedAt: Date | null
}

interface LoopContext {
	loopId: string
	loopTitle: string | null
	childObjectIds: string[]
}

interface WaitAnalysis {
	/** Result of the shared `isWaitingOnViewer` predicate applied to a step
	 * whose `waitingOnViewer` field the reconciler derived from the DB — this
	 * is the load-bearing agreement point with D3's AskBanner. */
	waitingOnViewer: boolean
	/** Timestamp of the oldest event still unread by the hands-off actor.
	 * Null when the actor is caught up (or there are no child objects). */
	waitingSince: Date | null
}

export class LoopEscalationReconciler {
	private timer: NodeJS.Timeout | null = null
	private startTimer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private tickMs: number = TICK_MS,
		/** Test seam — swap the env-based config gate without mutating process.env. */
		private readConfig: () => FeatureFlagConfig = getFeatureFlagConfig,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.tickMs)
		this.timer.unref?.()
		this.startTimer = setTimeout(() => this.tick(), START_DELAY_MS)
		this.startTimer.unref?.()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.startTimer) {
			clearTimeout(this.startTimer)
			this.startTimer = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		if (!this.isFlagOn()) return
		this.running = true
		try {
			const candidates = await this.loadCandidates()
			if (candidates.length === 0) return

			let posted = 0
			for (const step of candidates) {
				try {
					const escalated = await this.processStep(step)
					if (escalated) posted += 1
				} catch (err) {
					logger.error('Loop escalation reconciler failed for step', {
						triggerId: step.triggerId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (posted > 0) {
				logger.info('Loop escalation reconciler posted escalations', {
					candidatesConsidered: candidates.length,
					postedCount: posted,
				})
			}
		} catch (err) {
			logger.error('Loop escalation reconciler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private isFlagOn(): boolean {
		const config = this.readConfig()
		return (
			config.testerFlags.has(FLAGS.loopsV4Polish) &&
			config.testerFlags.has(FLAGS.loopsV4PolishStepFlow)
		)
	}

	private async loadCandidates(): Promise<CandidateStep[]> {
		const rows = await this.db
			.select({
				triggerId: triggers.id,
				triggerName: triggers.name,
				workspaceId: triggers.workspaceId,
				targetActorId: triggers.targetActorId,
				handsOffToActorId: triggers.handsOffToActorId,
				escalatesToActorId: triggers.escalatesToActorId,
				escalateAfterMs: triggers.escalateAfterMs,
				lastEscalatedAt: triggers.lastEscalatedAt,
			})
			.from(triggers)
			.where(
				and(
					eq(triggers.enabled, true),
					isNotNull(triggers.handsOffToActorId),
					isNotNull(triggers.escalatesToActorId),
					isNotNull(triggers.escalateAfterMs),
				),
			)

		const filtered: CandidateStep[] = []
		for (const row of rows) {
			if (
				row.handsOffToActorId === null ||
				row.escalatesToActorId === null ||
				row.escalateAfterMs === null
			) {
				continue
			}
			filtered.push({
				triggerId: row.triggerId,
				triggerName: row.triggerName,
				workspaceId: row.workspaceId,
				targetActorId: row.targetActorId,
				handsOffToActorId: row.handsOffToActorId,
				escalatesToActorId: row.escalatesToActorId,
				escalateAfterMs: row.escalateAfterMs,
				lastEscalatedAt: row.lastEscalatedAt,
			})
		}
		return filtered
	}

	private async processStep(step: CandidateStep): Promise<boolean> {
		const loop = await this.findParentLoop(step)
		if (!loop) return false

		const wait = await this.analyseWait(loop, step.handsOffToActorId)
		// Apply the shared predicate the D3 banner uses — the two sites cannot
		// diverge on what "stalled" means because they both hit this function.
		if (!isWaitingOnViewer({ waitingOnViewer: wait.waitingOnViewer })) return false
		if (!wait.waitingSince) return false

		const now = new Date()
		const ageMs = now.getTime() - wait.waitingSince.getTime()
		if (ageMs <= step.escalateAfterMs) return false

		// Per-wait-spell idempotency: if the last escalation was posted at or
		// after this wait spell started, we've already escalated for it.
		if (step.lastEscalatedAt && step.lastEscalatedAt >= wait.waitingSince) return false

		const handsOffActor = await this.loadActorName(step.handsOffToActorId)
		const content = `Escalating: ${step.triggerName} has been waiting ${formatAge(ageMs)} on ${handsOffActor}.`

		await postComment(this.db, {
			workspaceId: step.workspaceId,
			// Attribute the escalation to the step's target agent — that's the
			// actor operationally responsible for the step. Keeps the audit
			// trail clean without minting a system actor for this one path.
			actorId: step.targetActorId,
			entityId: loop.loopId,
			entityType: 'object',
			content,
			mentions: [step.escalatesToActorId],
			attention: 4,
		})

		await this.db
			.update(triggers)
			.set({ lastEscalatedAt: now, updatedAt: now })
			.where(eq(triggers.id, step.triggerId))

		return true
	}

	private async findParentLoop(step: CandidateStep): Promise<LoopContext | null> {
		// A trigger's parent loop is the `loop`-typed object in the same
		// workspace whose `metadata.trigger_ids` contains this trigger's id.
		// Uses JSONB `?` (array-element contains) which the loops route also
		// relies on to walk the same membership.
		const loopRows = await this.db
			.select({
				id: objects.id,
				title: objects.title,
			})
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, step.workspaceId),
					eq(objects.type, 'loop'),
					sql`${objects.metadata}->'trigger_ids' ? ${step.triggerId}`,
				),
			)
			.limit(1)

		const loop = loopRows[0]
		if (!loop) return null

		const childRows = await this.db
			.select({ id: objects.id })
			.from(relationships)
			.innerJoin(objects, eq(objects.id, relationships.targetId))
			.where(
				and(
					eq(relationships.sourceId, loop.id),
					eq(relationships.type, 'in_loop'),
					eq(objects.workspaceId, step.workspaceId),
				),
			)

		return {
			loopId: loop.id,
			loopTitle: loop.title,
			childObjectIds: childRows.map((r) => r.id),
		}
	}

	private async analyseWait(loop: LoopContext, viewerActorId: string): Promise<WaitAnalysis> {
		if (loop.childObjectIds.length === 0) {
			return { waitingOnViewer: false, waitingSince: null }
		}

		// Oldest event on any child object of the loop that:
		// - was authored by someone other than the viewer
		// - is newer than the viewer's last-read cursor for that object
		//   (last_read_event_id = 0 when there is no read_state row)
		// This is the same "unread events for the viewer" expression the
		// loops-list route uses — collapsed to the earliest such event so the
		// reconciler can measure the wait spell's start. Child-object IDs come
		// from a DB read (never user input) so inlining them into an ARRAY
		// literal is safe — mirrors the loops-list route's approach.
		const childIdArray = sql.raw(
			`ARRAY[${loop.childObjectIds.map((id) => `'${id}'`).join(',')}]::uuid[]`,
		)
		const result = await this.db.execute<{ oldest_unread_at: string | null }>(
			sql`
				SELECT MIN(e.created_at)::timestamptz AS oldest_unread_at
				FROM ${events} e
				WHERE e.entity_id = ANY(${childIdArray})
					AND e.actor_id <> ${viewerActorId}
					AND e.id > COALESCE(
						(
							SELECT last_read_event_id FROM read_state
							WHERE actor_id = ${viewerActorId}
								AND entity_type = 'object'
								AND entity_id = e.entity_id
						),
						0
					)
			`,
		)

		const oldest = result[0]?.oldest_unread_at
		if (!oldest) return { waitingOnViewer: false, waitingSince: null }
		return { waitingOnViewer: true, waitingSince: new Date(oldest) }
	}

	private async loadActorName(actorId: string): Promise<string> {
		const rows = await this.db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)
		return rows[0]?.name ?? 'the hand-off agent'
	}
}

/**
 * Human-friendly age. The escalation copy is one line, and a raw
 * "12h 4m 33s" reads worse than "12h" to the person the escalation is
 * paged to — round to the largest unit and drop the rest.
 */
export function formatAge(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h`
	const days = Math.floor(hours / 24)
	return `${days}d`
}
