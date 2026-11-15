/**
 * driver-wake.ts — wakes the driver of an object when something it drives changes (bet "Agents take
 * the lead", rule 4, task "Wake the driver when its work changes").
 *
 * The driver is woken, with the reason and the changed object in front of it, when:
 *   - every task its object breaks into has closed, or one of them failed or was discarded
 *     (child_tasks_closed);
 *   - the last open object that blocks it has closed (blocker_cleared);
 *   - its own object was moved to a new status by someone else (status_changed);
 *   - a decision card it posted expired with no answer (decision_expired).
 * An answered card already wakes the driver through the comment dispatcher.
 *
 * Limits, from the guardrails note:
 *   - a change the driver made itself wakes nobody;
 *   - one wake per object, reason and hour;
 *   - wakes for one driver and object that arrive close together, or while a run of that driver is
 *     on the object, are merged into one session;
 *   - a run another mechanism already started on the object (an event trigger, the comment
 *     dispatcher) is not doubled. The wake is dropped and counted as such;
 *   - the session goes through startSession(), so the cap, back-off and daily budget in
 *     self-start-limits.ts apply (start_reason `driver_wake`).
 *
 * Off unless the workspace has the `driver-wake` flag. One `driver_woken` analytics event per wake:
 * sent when the run ends (changed something or nothing) or straight away when the wake is dropped.
 *
 * The held wakes live in memory. A restart loses the ones still waiting to settle; the sweep for
 * overdue next steps is the backstop for those.
 *
 * Every server instance sees the same change and holds the same wake. They queue on an advisory lock
 * per driver and object, and the one that comes second finds the first one's session and reports
 * nothing. The session carries its wake reasons in its config, so it is the record of the wake even
 * if the driver_woken row failed to save.
 */
import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	forYouWithdrawals,
	objects,
	relationships,
	sessions,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import {
	TERMINAL_STATUSES_BY_TYPE,
	findDefaultOnSilenceOption,
	isDecisionExpired,
	parseCommentDecision,
	readChanges,
} from '@maskin/shared'
import { and, eq, gt, gte, inArray, notInArray, or, sql } from 'drizzle-orm'
import { isActorHumanPaused } from '../lib/agent-pause'
import {
	type DriverWakeDropReason,
	type DriverWakeReason,
	type DriverWakeSource,
	trackDriverWoken,
} from '../lib/analytics/driver-woken-events'
import { FLAGS, getFeatureFlagConfig, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { getLiveNextStep } from '../lib/next-steps'
import { GATE_BOOKKEEPING_ACTIONS, SessionNotAdmittedError } from './self-start-limits'
import { TERMINAL_STATUSES, startSession } from './session-lifecycle'

/** Wakes that arrive within this long of each other for one driver and object become one session. */
export const SETTLE_MS = 15_000
/** The same reason wakes the same driver on the same object at most once in this long. */
export const WAKE_WINDOW_MS = 60 * 60_000
/** How often expired decision cards are looked for. */
export const DECISION_SCAN_INTERVAL_MS = 5 * 60_000
/** Cards that expired longer ago than this when the server started are left alone. */
const DECISION_SCAN_FIRST_LOOKBACK_MS = 60 * 60_000
/** A card older than this is not looked at. Cards expire within days. */
const DECISION_CARD_MAX_AGE_MS = 14 * 24 * 60 * 60_000
const MAX_CHANGED_OBJECTS_IN_PROMPT = 5

export const DRIVER_WOKEN_ACTION = 'driver_woken'
/** What a heartbeat run writes when it moves something: a comment, a new or changed object, a next step. */
const HEARTBEAT_WORK_ACTIONS = [
	'commented',
	'created',
	'updated',
	'status_changed',
	'next_step_set',
	'next_step_updated',
	'next_step_closed',
]
const SESSION_END_ACTIONS = new Set([
	'session_completed',
	'session_failed',
	'session_timeout',
	'session_stopped',
])

// ── Pure decisions ─────────────────────────────────────────────────────────

export interface RelatedObject {
	id: string
	type: string
	status: string
}

export function isClosedStatus(type: string, status: string): boolean {
	return (TERMINAL_STATUSES_BY_TYPE[type] ?? []).includes(status)
}

/** A child that ended badly or was dropped. The parent's driver hears about it at once. */
export function isFailedOrDiscarded(status: string): boolean {
	return status === 'failed' || status === 'discarded'
}

/**
 * Whether the move of `changed` to `newStatus` should wake the driver of the object that breaks into
 * `children`. True when the child failed or was discarded, or when it closed and every other child
 * is closed too. `changed` is looked at with `newStatus`, not the status the row has now.
 */
export function childrenWakeParent(
	children: RelatedObject[],
	changedId: string,
	newStatus: string,
): boolean {
	const changed = children.find((c) => c.id === changedId)
	if (!changed) return false
	if (isFailedOrDiscarded(newStatus)) return true
	if (!isClosedStatus(changed.type, newStatus)) return false
	return children.every((c) => c.id === changedId || isClosedStatus(c.type, c.status))
}

/** Whether the move of `changed` to `newStatus` leaves nothing open that blocks the object. */
export function blockerCleared(
	blockers: RelatedObject[],
	changedId: string,
	newStatus: string,
): boolean {
	const changed = blockers.find((b) => b.id === changedId)
	if (!changed || !isClosedStatus(changed.type, newStatus)) return false
	return blockers.every((b) => b.id === changedId || isClosedStatus(b.type, b.status))
}

const REASON_TEXT: Record<DriverWakeReason, string> = {
	child_tasks_closed:
		'Every task under this object has closed, or one of them failed or was discarded.',
	blocker_cleared: 'The last open object that was blocking this one has closed.',
	decision_answered: 'A decision card you posted was answered.',
	decision_expired: 'A decision card you posted expired with no answer.',
	status_changed: 'Someone else moved this object to a new status.',
	step_overdue: 'The next step on this object is overdue.',
	no_next_step: 'This object has no next step.',
	behind_pace: 'This object is behind the pace its target needs.',
	new_evidence: 'Someone else commented, or a new insight arrived, since your last run.',
	floor_reached: 'Your last run was 3 days ago or more.',
	nothing_due: 'Nothing is due on what you drive.',
}

export interface WakePromptInput {
	object: { id: string; type: string; title: string | null; status: string }
	reasons: { reason: DriverWakeReason; changed: (RelatedObject & { title: string | null })[] }[]
	nextStep: { action: string; status: string; dueAt: Date } | null
}

/** Only the stored next step and the state of what changed. Nothing is invented for the agent to do. */
export function buildWakePrompt(input: WakePromptInput): string {
	const lines = [
		'You are being woken because something you drive changed. No person asked for this run.',
		'',
		`Object you drive: ${input.object.title ?? '(untitled)'} (${input.object.type}, ${input.object.status})`,
		`Object ID: ${input.object.id}`,
		'',
		'Why you were woken:',
	]
	for (const { reason, changed } of input.reasons) {
		lines.push(`- ${REASON_TEXT[reason]}`)
		for (const c of changed.slice(0, MAX_CHANGED_OBJECTS_IN_PROMPT)) {
			lines.push(`  Changed: ${c.title ?? '(untitled)'} (${c.type}, now ${c.status}), ID: ${c.id}`)
		}
	}
	if (input.nextStep) {
		lines.push(
			'',
			`Stored next step (${input.nextStep.status}, due ${input.nextStep.dueAt.toISOString()}): ${input.nextStep.action}`,
		)
	}
	lines.push(
		'',
		'Read the object and what changed, then do the next safe step for this outcome and keep its next step current. If the change needs nothing from you, change nothing and end the run.',
	)
	return lines.join('\n')
}

// ── Service ────────────────────────────────────────────────────────────────

interface WakeRequest {
	workspaceId: string
	driverId: string
	objectId: string
	reason: DriverWakeReason
	changedObjectId: string
	/** When the change happened. A run another mechanism started for it can be no older than this. */
	changedAt: Date
}

/**
 * What the wake transaction came to: another server already woke the driver for this change
 * (nothing to report), dropped with a reason, or a session started for `fresh` reasons.
 */
type WakeAttempt =
	| { peerWoke: true }
	| { dropped: DriverWakeDropReason }
	| { started: Awaited<ReturnType<typeof startSession>>; fresh: DriverWakeReason[] }

interface Held {
	workspaceId: string
	driverId: string
	objectId: string
	since: Date
	reasons: Map<DriverWakeReason, Set<string>>
	timer: NodeJS.Timeout | null
}

export interface DriverWakerOptions {
	settleMs?: number
	decisionScanIntervalMs?: number
	now?: () => Date
}

const keyOf = (driverId: string, objectId: string) => `${driverId}:${objectId}`

export class DriverWaker {
	private handler: ((event: PgEvent) => void) | null = null
	private scanTimer: NodeJS.Timeout | null = null
	private held = new Map<string, Held>()
	/** Sessions whose outcome was sent. A stop can report an end twice. */
	private reported = new Set<string>()
	private lastDecisionScan: Date
	private settleMs: number
	private scanIntervalMs: number
	private now: () => Date

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		opts: DriverWakerOptions = {},
	) {
		this.settleMs = opts.settleMs ?? SETTLE_MS
		this.scanIntervalMs = opts.decisionScanIntervalMs ?? DECISION_SCAN_INTERVAL_MS
		this.now = opts.now ?? (() => new Date())
		this.lastDecisionScan = new Date(this.now().getTime() - DECISION_SCAN_FIRST_LOOKBACK_MS)
	}

	start(): void {
		if (this.handler) return
		this.handler = (event: PgEvent) => {
			const run =
				event.action === 'status_changed'
					? this.onStatusChanged(event)
					: event.entity_type === 'session' && SESSION_END_ACTIONS.has(event.action)
						? this.onSessionEnded(event)
						: null
			run?.catch((err) =>
				logger.error('Driver wake handling failed', {
					eventId: event.event_id,
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		}
		this.bridge.on('event', this.handler)
		this.scanTimer = setInterval(() => {
			this.scanExpiredDecisions().catch((err) =>
				logger.error('Driver wake decision scan failed', { error: String(err) }),
			)
		}, this.scanIntervalMs)
		this.scanTimer.unref?.()
		logger.info('Driver waker started')
	}

	stop(): void {
		if (this.handler) {
			this.bridge.off('event', this.handler)
			this.handler = null
		}
		if (this.scanTimer) clearInterval(this.scanTimer)
		this.scanTimer = null
		for (const held of this.held.values()) if (held.timer) clearTimeout(held.timer)
		this.held.clear()
	}

	private enabled(workspaceId: string): boolean {
		return isFlagEnabledForWorkspace(workspaceId, FLAGS.DRIVER_WAKE)
	}

	/** Whether any workspace has the flag. The flag list comes from the environment, so it holds until a restart. */
	private anyWorkspaceEnabled(): boolean {
		const suffix = `:${FLAGS.DRIVER_WAKE}`
		for (const entry of getFeatureFlagConfig().workspaceFeatures) {
			if (entry.endsWith(suffix)) return true
		}
		return false
	}

	// ── Finding what to wake ────────────────────────────────────────────────

	async onStatusChanged(event: PgEvent): Promise<void> {
		if (!this.enabled(event.workspace_id)) return
		const [row] = await this.db
			.select({ data: events.data, createdAt: events.createdAt })
			.from(events)
			.where(eq(events.id, Number(event.event_id)))
			.limit(1)
		const change = readChanges(row?.data)?.find((c) => c.field === 'status')
		if (!change || typeof change.new !== 'string') return
		const newStatus = change.new
		const changedAt = row?.createdAt ?? this.now()

		const [obj] = await this.db
			.select({
				id: objects.id,
				type: objects.type,
				workspaceId: objects.workspaceId,
				driver: objects.driver,
			})
			.from(objects)
			.where(eq(objects.id, event.entity_id))
			.limit(1)
		if (!obj || obj.workspaceId !== event.workspace_id) return

		const requests: WakeRequest[] = []
		const add = (target: { id: string; driver: string | null }, reason: DriverWakeReason) => {
			if (!target.driver || target.driver === event.actor_id) return
			requests.push({
				workspaceId: obj.workspaceId,
				driverId: target.driver,
				objectId: target.id,
				reason,
				changedObjectId: obj.id,
				changedAt,
			})
		}

		if (!isClosedStatus(obj.type, newStatus)) add(obj, 'status_changed')

		if (isClosedStatus(obj.type, newStatus) || isFailedOrDiscarded(newStatus)) {
			for (const parent of await this.related(obj.id, 'parents', 'breaks_into')) {
				if (isClosedStatus(parent.type, parent.status)) continue
				const children = await this.related(parent.id, 'children', 'breaks_into')
				if (childrenWakeParent(children, obj.id, newStatus)) add(parent, 'child_tasks_closed')
			}
		}
		if (isClosedStatus(obj.type, newStatus)) {
			for (const blocked of await this.related(obj.id, 'children', 'blocks')) {
				if (isClosedStatus(blocked.type, blocked.status)) continue
				const blockers = await this.related(blocked.id, 'parents', 'blocks')
				if (blockerCleared(blockers, obj.id, newStatus)) add(blocked, 'blocker_cleared')
			}
		}

		const agents = await this.agentIds(requests.map((r) => r.driverId))
		for (const r of requests) if (agents.has(r.driverId)) this.hold(r)
	}

	/**
	 * Objects joined to `id` by an edge of `type`. `children`: id is the source. `parents`: id is
	 * the target. Each row carries the driver, for the caller that needs it.
	 */
	private async related(
		id: string,
		direction: 'children' | 'parents',
		type: 'breaks_into' | 'blocks',
	): Promise<(RelatedObject & { driver: string | null })[]> {
		const [from, to] =
			direction === 'children'
				? [relationships.sourceId, relationships.targetId]
				: [relationships.targetId, relationships.sourceId]
		return this.db
			.select({
				id: objects.id,
				type: objects.type,
				status: objects.status,
				driver: objects.driver,
			})
			.from(relationships)
			.innerJoin(objects, eq(objects.id, to))
			.where(
				and(
					eq(from, id),
					eq(relationships.type, type),
					eq(relationships.sourceType, 'object'),
					eq(relationships.targetType, 'object'),
				),
			)
	}

	private async agentIds(ids: string[]): Promise<Set<string>> {
		if (ids.length === 0) return new Set()
		const rows = await this.db
			.select({ id: actors.id })
			.from(actors)
			.where(and(inArray(actors.id, ids), eq(actors.type, 'agent')))
		return new Set(rows.map((r) => r.id))
	}

	/** Cards the driver posted that ran out with no answer since the last look. */
	async scanExpiredDecisions(): Promise<void> {
		if (!this.anyWorkspaceEnabled()) return
		const now = this.now()
		const from = this.lastDecisionScan
		this.lastDecisionScan = now
		const rows = await this.db
			.select({
				id: events.id,
				workspaceId: events.workspaceId,
				actorId: events.actorId,
				entityId: events.entityId,
				data: events.data,
			})
			.from(events)
			.where(
				and(
					eq(events.action, 'commented'),
					eq(events.entityType, 'object'),
					gte(events.createdAt, new Date(now.getTime() - DECISION_CARD_MAX_AGE_MS)),
					sql`${events.data}->'decision'->>'expires_at' IS NOT NULL`,
				),
			)
		for (const row of rows) {
			if (!this.enabled(row.workspaceId)) continue
			const decision = parseCommentDecision((row.data as { decision?: unknown } | null)?.decision)
			if (!decision?.expires_at || !isDecisionExpired(decision, now)) continue
			if (new Date(decision.expires_at).getTime() <= from.getTime()) continue
			// A card with a default on silence is carried out by DecisionDefaultWake, which names the
			// default. Waking the driver here too would start two runs for one card.
			if (
				findDefaultOnSilenceOption(decision) &&
				isFlagEnabledForWorkspace(row.workspaceId, FLAGS.DECISION_DEFAULT)
			)
				continue
			await this.requestForExpiredCard({ ...row, id: Number(row.id) })
		}
	}

	private async requestForExpiredCard(card: {
		id: number
		workspaceId: string
		actorId: string
		entityId: string
	}): Promise<void> {
		const [obj] = await this.db
			.select({
				id: objects.id,
				type: objects.type,
				status: objects.status,
				driver: objects.driver,
			})
			.from(objects)
			.where(eq(objects.id, card.entityId))
			.limit(1)
		// Only the driver's own card, on an object still open.
		if (!obj || obj.driver !== card.actorId || isClosedStatus(obj.type, obj.status)) return
		if (!(await this.agentIds([card.actorId])).has(card.actorId)) return

		const [withdrawn] = await this.db
			.select({ id: forYouWithdrawals.sourceCommentId })
			.from(forYouWithdrawals)
			.where(eq(forYouWithdrawals.sourceCommentId, card.id))
			.limit(1)
		if (withdrawn) return
		// Anyone but the driver commenting after the card counts as an answer.
		const [answer] = await this.db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.entityId, card.entityId),
					eq(events.action, 'commented'),
					gt(events.id, card.id),
					sql`${events.actorId} <> ${card.actorId}`,
				),
			)
			.limit(1)
		if (answer) return

		this.hold({
			workspaceId: card.workspaceId,
			driverId: card.actorId,
			objectId: obj.id,
			reason: 'decision_expired',
			changedObjectId: obj.id,
			changedAt: this.now(),
		})
	}

	// ── Holding and merging ─────────────────────────────────────────────────

	private hold(req: WakeRequest): void {
		const key = keyOf(req.driverId, req.objectId)
		let held = this.held.get(key)
		if (!held) {
			held = {
				workspaceId: req.workspaceId,
				driverId: req.driverId,
				objectId: req.objectId,
				since: req.changedAt,
				reasons: new Map(),
				timer: null,
			}
			this.held.set(key, held)
		}
		if (req.changedAt < held.since) held.since = req.changedAt
		const changed = held.reasons.get(req.reason) ?? new Set<string>()
		changed.add(req.changedObjectId)
		held.reasons.set(req.reason, changed)
		if (!held.timer) {
			held.timer = setTimeout(() => {
				this.flush(key).catch((err) =>
					logger.error('Driver wake failed', { key, error: String(err) }),
				)
			}, this.settleMs)
			held.timer.unref?.()
		}
	}

	/** Starts the merged wake for one driver and object, unless a run of the driver is on the object. */
	async flush(key: string): Promise<void> {
		const held = this.held.get(key)
		if (!held) return
		held.timer = null
		if (!this.enabled(held.workspaceId)) {
			this.held.delete(key)
			return
		}
		// Kept until that run ends: onSessionEnded() flushes it then.
		if (await this.liveRunOn(held)) return
		this.held.delete(key)
		await this.wake(held)
	}

	private async liveRunOn(held: Held): Promise<boolean> {
		const [row] = await this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, held.workspaceId),
					eq(sessions.actorId, held.driverId),
					eq(sessions.initiatedFromObjectId, held.objectId),
					notInArray(sessions.status, [...TERMINAL_STATUSES]),
					sql`${sessions.completedAt} IS NULL`,
				),
			)
			.limit(1)
		return !!row
	}

	private async drop(held: Held, reasons: DriverWakeReason[], why: DriverWakeDropReason) {
		logger.info('Driver wake dropped', {
			workspace_id: held.workspaceId,
			agent_id: held.driverId,
			object_id: held.objectId,
			reasons,
			why,
		})
		for (const reason of reasons) {
			await trackDriverWoken({
				workspaceId: held.workspaceId,
				agentId: held.driverId,
				source: 'state_change',
				reason,
				outcome: 'dropped_other_mechanism',
				dropReason: why,
			})
		}
	}

	private async wake(held: Held): Promise<void> {
		const reasons = [...held.reasons.keys()]
		if (await isActorHumanPaused(this.db, held.driverId)) return this.drop(held, reasons, 'paused')

		const [object] = await this.db
			.select({ id: objects.id, type: objects.type, title: objects.title, status: objects.status })
			.from(objects)
			.where(eq(objects.id, held.objectId))
			.limit(1)
		if (!object || isClosedStatus(object.type, object.status)) return

		const changedIds = [...new Set([...held.reasons.values()].flatMap((s) => [...s]))]
		const changedRows = await this.db
			.select({ id: objects.id, type: objects.type, status: objects.status, title: objects.title })
			.from(objects)
			.where(inArray(objects.id, changedIds))
		const nextStep = await getLiveNextStep(this.db, held.objectId)

		const handle: WakeAttempt = await this.db
			.transaction(async (tx): Promise<WakeAttempt> => {
				// Every server sees the same change and holds the same wake. They queue on this lock, so
				// whoever comes second finds what the first one did.
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtext(${`driver-wake:${held.driverId}:${held.objectId}`}))`,
				)

				// Another server woke the driver for this change while we waited. Nothing to report: the
				// wake happened, and a dropped event here would count one wake twice.
				if (await this.wokeSince(tx, held, reasons, held.since)) return { peerWoke: true }

				// A run the driver already has on the object since the change: an event trigger or the
				// comment dispatcher got there first.
				const [existing] = await tx
					.select({ id: sessions.id })
					.from(sessions)
					.where(
						and(
							eq(sessions.workspaceId, held.workspaceId),
							eq(sessions.actorId, held.driverId),
							eq(sessions.initiatedFromObjectId, held.objectId),
							gte(sessions.createdAt, held.since),
						),
					)
					.limit(1)
				if (existing) return { dropped: 'run_already_started' }

				const windowStart = new Date(this.now().getTime() - WAKE_WINDOW_MS)
				const fresh: DriverWakeReason[] = []
				for (const reason of reasons) {
					if (!(await this.wokeSince(tx, held, [reason], windowStart))) fresh.push(reason)
				}
				if (fresh.length === 0) return { dropped: 'rate_limited' }

				const started = await startSession({
					workspaceId: held.workspaceId,
					actorId: held.driverId,
					callerKind: 'internal',
					actionPrompt: buildWakePrompt({
						object,
						reasons: fresh.map((reason) => ({
							reason,
							changed: changedRows.filter((c) => held.reasons.get(reason)?.has(c.id)),
						})),
						nextStep: nextStep
							? { action: nextStep.action, status: nextStep.status, dueAt: nextStep.dueAt }
							: null,
					}),
					config: {
						start_reason: 'driver_wake',
						driver_wake: {
							source: 'state_change',
							reasons: fresh,
							changed_object_ids: changedIds,
						},
					},
					createdBy: held.driverId,
					initiatedFromObjectId: held.objectId,
				})
				for (const reason of fresh) {
					await tx.insert(events).values({
						workspaceId: held.workspaceId,
						actorId: held.driverId,
						action: DRIVER_WOKEN_ACTION,
						entityType: 'session',
						entityId: started.sessionId,
						data: { object_id: held.objectId, reason },
					})
				}
				return { started, fresh }
			})
			.catch((err): WakeAttempt => {
				if (err instanceof SessionNotAdmittedError) return { dropped: 'not_admitted' }
				throw err
			})

		if ('peerWoke' in handle) return
		if ('dropped' in handle) return this.drop(held, reasons, handle.dropped)

		// The session is the object's live one, as the task restarter links it.
		await this.db
			.update(objects)
			.set({ activeSessionId: handle.started.sessionId, updatedAt: this.now() })
			.where(and(eq(objects.id, held.objectId), sql`${objects.activeSessionId} IS NULL`))
		const rateLimited = reasons.filter((r) => !handle.fresh.includes(r))
		if (rateLimited.length > 0) await this.drop(held, rateLimited, 'rate_limited')
	}

	/**
	 * Whether the driver was woken on the object for any of `reasons` since `after`. Two records
	 * say yes: the driver_woken row, and the session itself, which carries the reasons in its config.
	 * The session is written by startSession in one step, so a wake whose row failed to save still
	 * counts, and a start that threw (nothing written) counts for nothing.
	 */
	private async wokeSince(
		db: Database | Transaction,
		held: Held,
		reasons: DriverWakeReason[],
		after: Date,
	): Promise<boolean> {
		const [row] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, held.workspaceId),
					eq(events.actorId, held.driverId),
					eq(events.action, DRIVER_WOKEN_ACTION),
					gte(events.createdAt, after),
					sql`${events.data}->>'object_id' = ${held.objectId}`,
					inArray(sql`${events.data}->>'reason'`, reasons),
				),
			)
			.limit(1)
		if (row) return true
		const [session] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, held.workspaceId),
					eq(sessions.actorId, held.driverId),
					eq(sessions.initiatedFromObjectId, held.objectId),
					gte(sessions.createdAt, after),
					or(
						...reasons.map(
							(r) =>
								sql`(${sessions.config})::jsonb->'driver_wake'->'reasons' @> ${JSON.stringify([r])}::jsonb`,
						),
					),
				),
			)
			.limit(1)
		return !!session
	}

	// ── When a run ends ─────────────────────────────────────────────────────

	async onSessionEnded(event: PgEvent): Promise<void> {
		const [session] = await this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				objectId: sessions.initiatedFromObjectId,
				config: sessions.config,
				createdAt: sessions.createdAt,
				startedAt: sessions.startedAt,
			})
			.from(sessions)
			.where(eq(sessions.id, event.entity_id))
			.limit(1)
		if (!session) return

		// Runs the sweep and the heartbeat pre-check started carry the same marker, with their source.
		const wake = (
			session.config as { driver_wake?: { reasons?: unknown; source?: unknown } } | null
		)?.driver_wake
		if (wake && Array.isArray(wake.reasons) && !this.reported.has(session.id)) {
			this.reported.add(session.id)
			if (this.reported.size > 500)
				this.reported.delete(this.reported.values().next().value as string)
			await this.reportOutcome(
				session,
				wake.reasons as DriverWakeReason[],
				wake.source === 'sweep' || wake.source === 'heartbeat' ? wake.source : 'state_change',
			)
		}

		// Wakes that were kept while this run was on the object go out as one session now.
		if (session.objectId) {
			const key = keyOf(session.actorId, session.objectId)
			if (this.held.has(key)) await this.flush(key)
		}
	}

	/**
	 * Did the run act? Any event the agent wrote on the object during the run says yes. A run with
	 * no object (a heartbeat) counts the agent's own writes anywhere in the workspace.
	 */
	private async reportOutcome(
		session: {
			id: string
			workspaceId: string
			actorId: string
			objectId: string | null
			createdAt: Date | null
			startedAt: Date | null
		},
		reasons: DriverWakeReason[],
		source: DriverWakeSource,
	): Promise<void> {
		const from = session.startedAt ?? session.createdAt ?? new Date(0)
		const [changed] = await this.db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, session.workspaceId),
					eq(events.actorId, session.actorId),
					gte(events.createdAt, from),
					session.objectId
						? and(
								eq(events.entityId, session.objectId),
								notInArray(events.action, GATE_BOOKKEEPING_ACTIONS),
							)
						: inArray(events.action, HEARTBEAT_WORK_ACTIONS),
				),
			)
			.limit(1)
		for (const reason of reasons) {
			await trackDriverWoken({
				workspaceId: session.workspaceId,
				agentId: session.actorId,
				source,
				reason,
				outcome: changed ? 'changed_something' : 'changed_nothing',
			})
		}
	}
}
