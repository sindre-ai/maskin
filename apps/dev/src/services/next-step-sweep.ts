/**
 * next-step-sweep.ts — plain-code backstop for lost wake-ups (bet "Agents take the lead", rule 4,
 * task "Sweep for overdue next steps, wake drivers"). No model call.
 *
 * Every 5 minutes, on every server instance, for each workspace with the `next-step-sweep` flag:
 *   - overdue: an open next step more than 5 minutes past due;
 *   - no step: a covered object (see NEXT_STEP_COVERED_OBJECTS) driven by an agent with no open or
 *     blocked step, not updated for 2 hours.
 * Skipped without a trace: a driver a person paused, an object that already has a run on it or had
 * one in the last hour (from any mechanism), and an object where the driver has a live decision
 * card (a person is being waited on, which is not stuck).
 *
 * Stop double action. Inserting the claim row (next_step_sweep_claims) is the claim: one decision
 * per object, reason and hour across all instances. The wake goes through startSession(), so the
 * cap, the back-off (after 2 quiet wakes the wait doubles, after 3 a person is asked) and the daily
 * budget in self-start-limits.ts apply (start_reason `sweep`).
 *
 * First-run flood guard. The day this goes live every driven object in the list has no step. So a
 * workspace is RECORD-ONLY until the sweep has been recording there for 3 days and the second flag
 * `next-step-sweep-wake` is on: it writes the claim row and the driver_woken analytics event
 * (outcome recorded_only) and starts nothing. A woken tick starts at most 3 runs per agent.
 * Comparing the recorded list with what is really stuck is a person's step before that flag goes on.
 *
 * One `driver_woken` event per decision, source `sweep`. The outcome of a run it started is sent
 * by DriverWaker.onSessionEnded().
 */
import type { Database } from '@maskin/db'
import {
	events,
	forYouWithdrawals,
	nextStepSweepClaims,
	nextSteps,
	objects,
	sessions,
} from '@maskin/db/schema'
import { isDecisionExpired, parseCommentDecision } from '@maskin/shared'
import { and, eq, gte, inArray, isNull, min, notInArray, or, sql } from 'drizzle-orm'
import { isActorHumanPaused } from '../lib/agent-pause'
import { type DriverWakeReason, trackDriverWoken } from '../lib/analytics/driver-woken-events'
import { FLAGS, getFeatureFlagConfig, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import {
	type ObjectNeedingNextStep,
	findObjectsNeedingNextStep,
	getLiveNextStep,
} from '../lib/next-steps'
import { DRIVER_WOKEN_ACTION, buildWakePrompt } from './driver-wake'
import { SessionNotAdmittedError } from './self-start-limits'
import { TERMINAL_STATUSES, startSession } from './session-lifecycle'

export const SWEEP_INTERVAL_MS = 5 * 60_000
/** An object with no step is only picked up when it has not been touched for this long. */
export const NO_STEP_QUIET_MS = 2 * 60 * 60_000
/** ASSUMED, no source: record only for this long before a workspace may start runs. */
export const RECORD_ONLY_MS = 3 * 24 * 60 * 60_000
/** ASSUMED, no source: runs one agent may be woken for in one tick. */
export const MAX_WAKES_PER_AGENT_PER_TICK = 3
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** A decision card older than this is not looked at. Cards expire within days. */
const DECISION_CARD_MAX_AGE_MS = 14 * DAY_MS
/** Objects looked at per workspace per tick. The rest wait for the next tick. */
const CANDIDATES_PER_WORKSPACE = 500

export type SweepMode = 'off' | 'record' | 'wake'
export type SweepReason = Extract<DriverWakeReason, 'step_overdue' | 'no_next_step'>

// ── Pure decisions ─────────────────────────────────────────────────────────

/**
 * What the sweep does in a workspace. `firstRecordedAt` is the oldest claim row there: the wake
 * flag alone never starts a run in the first 3 days of recording, so flipping both flags the same
 * day cannot flood the agents.
 */
export function sweepMode(input: {
	sweepOn: boolean
	wakeOn: boolean
	firstRecordedAt: Date | null
	now: Date
}): SweepMode {
	if (!input.sweepOn) return 'off'
	if (!input.wakeOn || !input.firstRecordedAt) return 'record'
	return input.now.getTime() - input.firstRecordedAt.getTime() >= RECORD_ONLY_MS ? 'wake' : 'record'
}

export function reasonFor(found: Pick<ObjectNeedingNextStep, 'reason'>): SweepReason {
	return found.reason === 'overdue' ? 'step_overdue' : 'no_next_step'
}

/** Start of the time bucket a claim belongs to: the hour when waking, the day when recording. */
export function bucketStart(now: Date, mode: 'record' | 'wake'): Date {
	const size = mode === 'wake' ? HOUR_MS : DAY_MS
	return new Date(Math.floor(now.getTime() / size) * size)
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * Of `objectIds`, those with a run on them now, or one that started in the last hour: by any
 * agent or person, from any mechanism. The sweep leaves these alone.
 */
export async function findBusyObjectIds(
	db: Database,
	objectIds: string[],
	now: Date,
): Promise<Set<string>> {
	if (objectIds.length === 0) return new Set()
	const rows = await db
		.selectDistinct({ id: sessions.initiatedFromObjectId })
		.from(sessions)
		.where(
			and(
				inArray(sessions.initiatedFromObjectId, objectIds),
				or(
					and(isNull(sessions.completedAt), notInArray(sessions.status, [...TERMINAL_STATUSES])),
					gte(sessions.createdAt, new Date(now.getTime() - HOUR_MS)),
				),
			),
		)
	return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])))
}

/**
 * Of `candidates`, those where the driver's own decision card is live: it has no expiry or has not
 * expired, was not withdrawn, and nobody but the driver has commented since. A person is then being
 * waited on. The same reading as the expired-card scan in driver-wake.ts.
 */
export async function findObjectsWithLiveDecisionCard(
	db: Database,
	candidates: { objectId: string; driverId: string }[],
	now: Date,
): Promise<Set<string>> {
	if (candidates.length === 0) return new Set()
	const driverByObject = new Map(candidates.map((c) => [c.objectId, c.driverId]))
	const cards = await db
		.select({
			id: events.id,
			actorId: events.actorId,
			entityId: events.entityId,
			data: events.data,
		})
		.from(events)
		.where(
			and(
				eq(events.action, 'commented'),
				eq(events.entityType, 'object'),
				inArray(events.entityId, [...driverByObject.keys()]),
				gte(events.createdAt, new Date(now.getTime() - DECISION_CARD_MAX_AGE_MS)),
				sql`${events.data}->'decision' IS NOT NULL`,
			),
		)
	const covered = new Set<string>()
	for (const card of cards) {
		if (covered.has(card.entityId) || card.actorId !== driverByObject.get(card.entityId)) continue
		const decision = parseCommentDecision((card.data as { decision?: unknown } | null)?.decision)
		if (!decision || isDecisionExpired(decision, now)) continue
		const [answered] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.entityId, card.entityId),
					eq(events.action, 'commented'),
					sql`${events.id} > ${card.id}`,
					sql`${events.actorId} <> ${card.actorId}`,
				),
			)
			.limit(1)
		if (answered) continue
		const [withdrawn] = await db
			.select({ id: forYouWithdrawals.sourceCommentId })
			.from(forYouWithdrawals)
			.where(eq(forYouWithdrawals.sourceCommentId, card.id))
			.limit(1)
		if (!withdrawn) covered.add(card.entityId)
	}
	return covered
}

// ── Service ────────────────────────────────────────────────────────────────

export interface NextStepSweepOptions {
	intervalMs?: number
	now?: () => Date
}

export class NextStepSweep {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private now: () => Date
	private intervalMs: number

	constructor(
		private db: Database,
		opts: NextStepSweepOptions = {},
	) {
		this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS
		this.now = opts.now ?? (() => new Date())
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) => logger.error('Next step sweep failed', { error: String(err) }))
		}, this.intervalMs)
		this.timer.unref?.()
		logger.info('Next step sweep started')
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	/** Workspaces whose flag list names the sweep. The list comes from the environment. */
	private flaggedWorkspaceIds(): string[] {
		const suffix = `:${FLAGS.NEXT_STEP_SWEEP}`
		const ids: string[] = []
		for (const entry of getFeatureFlagConfig().workspaceFeatures) {
			if (entry.endsWith(suffix)) ids.push(entry.slice(0, -suffix.length))
		}
		return ids
	}

	/** One pass over every flagged workspace. A pass that is still running is not started twice. */
	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			for (const workspaceId of this.flaggedWorkspaceIds()) {
				await this.sweepWorkspace(workspaceId).catch((err) =>
					logger.error('Next step sweep failed for a workspace', {
						workspace_id: workspaceId,
						error: String(err),
					}),
				)
			}
		} finally {
			this.running = false
		}
	}

	async sweepWorkspace(workspaceId: string): Promise<void> {
		const now = this.now()
		const [first] = await this.db
			.select({ at: min(nextStepSweepClaims.createdAt) })
			.from(nextStepSweepClaims)
			.where(eq(nextStepSweepClaims.workspaceId, workspaceId))
		const mode = sweepMode({
			sweepOn: isFlagEnabledForWorkspace(workspaceId, FLAGS.NEXT_STEP_SWEEP),
			wakeOn: isFlagEnabledForWorkspace(workspaceId, FLAGS.NEXT_STEP_SWEEP_WAKE),
			firstRecordedAt: first?.at ?? null,
			now,
		})
		if (mode === 'off') return

		const found = await findObjectsNeedingNextStep(this.db, {
			workspaceId,
			now,
			notUpdatedSince: new Date(now.getTime() - NO_STEP_QUIET_MS),
			limit: CANDIDATES_PER_WORKSPACE,
		})
		if (found.length === 0) return

		const ids = found.map((f) => f.objectId)
		const [busy, covered] = await Promise.all([
			findBusyObjectIds(this.db, ids, now),
			findObjectsWithLiveDecisionCard(this.db, found, now),
		])
		const wokenPerAgent = new Map<string, number>()
		const paused = new Map<string, boolean>()

		for (const item of found) {
			if (busy.has(item.objectId) || covered.has(item.objectId)) continue
			if (!paused.has(item.driverId)) {
				paused.set(item.driverId, await isActorHumanPaused(this.db, item.driverId))
			}
			if (paused.get(item.driverId)) continue
			if (
				mode === 'wake' &&
				(wokenPerAgent.get(item.driverId) ?? 0) >= MAX_WAKES_PER_AGENT_PER_TICK
			)
				continue

			const claimed = await this.claim(item, mode, now)
			if (!claimed) continue
			if (mode === 'record') {
				await trackDriverWoken({
					workspaceId,
					agentId: item.driverId,
					source: 'sweep',
					reason: reasonFor(item),
					outcome: 'recorded_only',
				})
				continue
			}
			wokenPerAgent.set(item.driverId, (wokenPerAgent.get(item.driverId) ?? 0) + 1)
			await this.wake(item, claimed, now)
		}
	}

	/** Inserting the row is the claim. Null when another instance, or an earlier tick, has it. */
	private async claim(
		item: ObjectNeedingNextStep,
		mode: 'record' | 'wake',
		now: Date,
	): Promise<string | null> {
		const [row] = await this.db
			.insert(nextStepSweepClaims)
			.values({
				workspaceId: item.workspaceId,
				objectId: item.objectId,
				driverActorId: item.driverId,
				reason: reasonFor(item),
				bucketStart: bucketStart(now, mode),
				mode: mode === 'wake' ? 'woken' : 'recorded',
			})
			.onConflictDoNothing()
			.returning({ id: nextStepSweepClaims.id })
		return row?.id ?? null
	}

	private async wake(item: ObjectNeedingNextStep, claimId: string, now: Date): Promise<void> {
		const reason = reasonFor(item)
		const free = () =>
			this.db.delete(nextStepSweepClaims).where(eq(nextStepSweepClaims.id, claimId))

		const [object] = await this.db
			.select({ id: objects.id, type: objects.type, title: objects.title, status: objects.status })
			.from(objects)
			.where(eq(objects.id, item.objectId))
			.limit(1)
		if (!object) return void (await free())
		const nextStep = await getLiveNextStep(this.db, item.objectId)

		let sessionId: string
		try {
			const started = await startSession({
				workspaceId: item.workspaceId,
				actorId: item.driverId,
				callerKind: 'internal',
				actionPrompt: buildWakePrompt({
					object,
					reasons: [{ reason, changed: [] }],
					nextStep: nextStep
						? { action: nextStep.action, status: nextStep.status, dueAt: nextStep.dueAt }
						: null,
				}),
				config: {
					start_reason: 'sweep',
					driver_wake: { source: 'sweep', reasons: [reason], changed_object_ids: [] },
				},
				createdBy: item.driverId,
				initiatedFromObjectId: item.objectId,
			})
			sessionId = started.sessionId
		} catch (err) {
			if (err instanceof SessionNotAdmittedError) {
				await this.db
					.update(nextStepSweepClaims)
					.set({ mode: 'refused' })
					.where(eq(nextStepSweepClaims.id, claimId))
				return trackDriverWoken({
					workspaceId: item.workspaceId,
					agentId: item.driverId,
					source: 'sweep',
					reason,
					outcome: 'dropped_other_mechanism',
					dropReason: 'not_admitted',
				})
			}
			// Not decided: free the claim so the next tick tries this object again.
			await free()
			logger.error('Next step sweep could not start a run', {
				workspace_id: item.workspaceId,
				object_id: item.objectId,
				error: String(err),
			})
			return
		}

		await this.db.insert(events).values({
			workspaceId: item.workspaceId,
			actorId: item.driverId,
			action: DRIVER_WOKEN_ACTION,
			entityType: 'session',
			entityId: sessionId,
			data: { object_id: item.objectId, reason },
		})
		// The session is the object's live one, as the task restarter links it.
		await this.db
			.update(objects)
			.set({ activeSessionId: sessionId, updatedAt: now })
			.where(and(eq(objects.id, item.objectId), sql`${objects.activeSessionId} IS NULL`))
		if (nextStep) {
			await this.db
				.update(nextSteps)
				.set({ wakeCount: sql`${nextSteps.wakeCount} + 1`, lastWokenAt: now })
				.where(eq(nextSteps.id, nextStep.id))
		}
	}
}
