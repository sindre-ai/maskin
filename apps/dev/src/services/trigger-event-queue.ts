import type { Database } from '@maskin/db'
import { triggerEventQueue } from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { and, asc, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import {
	type TriggerQueueDrainSource,
	type TriggerQueueReason,
	trackTriggerEventQueued,
	trackTriggerEventReplayed,
	trackTriggerQueueOverflow,
} from '../lib/analytics/trigger-queue-events'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'

/**
 * Hold-and-replay storage for events the trigger-runner used to drop (tech spec
 * §4). The runner owns WHEN to enqueue and drain; this module owns the rows:
 * backpressure caps, the FIFO drain query, and retention.
 */

/** Per-trigger cap on pending rows. 30 min backoff x 100 events/min = 3,000; 10k leaves headroom (§4.5). */
export const TRIGGER_QUEUE_CAP = 10_000
/** Per-workspace cap across all triggers, so one runaway trigger cannot starve its neighbours (§4.5). */
export const WORKSPACE_QUEUE_CAP = 100_000
/** Rows claimed per drain batch (§4.3). */
export const DRAIN_BATCH_SIZE = 500
/** Background drain sweep cadence (§4.4). */
export const QUEUE_SWEEP_INTERVAL_MS = 30_000
/** Distinct triggers / workspaces the sweep picks up per tick (§4.4). */
export const QUEUE_SWEEP_SCOPE_LIMIT = 100
/** Rows older than this are deleted whether replayed or not; no durability beyond 7 days (§4.5, §9). */
export const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60_000

/**
 * Action / entity_type stamped on the events the queue writes about itself.
 * The entity type is deliberately NOT 'trigger': the runner routes every
 * entity_type = 'trigger' event to handleTriggerChange, which resets that
 * trigger's backoff — an overflow event on a cooling trigger would lift the
 * very cooldown that filled the queue. The runner also refuses to enqueue
 * these events, otherwise an overflowing workspace would write an event per
 * dropped event, each of which would try to enqueue again.
 */
export const QUEUE_EVENT_ENTITY_TYPE = 'trigger_event_queue'

export type EnqueueOutcome = 'queued' | 'overflow' | 'write_failed'

export interface EnqueueOptions {
	reason: TriggerQueueReason
	/** Null for a workspace-suppression drop; fanned out per trigger at replay. */
	triggerId: string | null
	replayAfter: Date
}

async function countPending(
	db: Database,
	where: ReturnType<typeof and>,
	cap: number,
): Promise<number> {
	// Bounded count: stop scanning at the cap instead of counting a backlog of
	// 100k rows on every enqueue.
	const pending = db
		.select({ one: sql`1`.as('one') })
		.from(triggerEventQueue)
		.where(where)
		.limit(cap)
		.as('pending')
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pending)
	return row?.n ?? 0
}

/**
 * Parks a dropped event in the queue. Never throws: a failed write is logged,
 * announced with trigger_queue_write_failed, and the event is dropped — which
 * is what happened to it before the queue existed (§6.3).
 */
export async function enqueueDroppedEvent(
	db: Database,
	event: PgEvent,
	opts: EnqueueOptions,
): Promise<EnqueueOutcome> {
	const eventId = Number(event.event_id)
	try {
		const perWorkspace = await countPending(
			db,
			and(
				eq(triggerEventQueue.workspaceId, event.workspace_id),
				isNull(triggerEventQueue.replayedAt),
			),
			WORKSPACE_QUEUE_CAP,
		)
		const perTrigger = opts.triggerId
			? await countPending(
					db,
					and(
						eq(triggerEventQueue.triggerId, opts.triggerId),
						isNull(triggerEventQueue.replayedAt),
					),
					TRIGGER_QUEUE_CAP,
				)
			: 0

		if (perWorkspace >= WORKSPACE_QUEUE_CAP || perTrigger >= TRIGGER_QUEUE_CAP) {
			const scope = perTrigger >= TRIGGER_QUEUE_CAP ? 'trigger' : 'workspace'
			logger.warn('Trigger event queue overflow — dropping event', {
				workspaceId: event.workspace_id,
				triggerId: opts.triggerId,
				eventId: event.event_id,
				scope,
				reason: opts.reason,
			})
			await recordEvent(db, {
				workspaceId: event.workspace_id,
				actorId: event.actor_id,
				action: 'trigger_queue_overflow',
				entityType: QUEUE_EVENT_ENTITY_TYPE,
				entityId: opts.triggerId ?? event.workspace_id,
				data: {
					event_id: event.event_id,
					reason: opts.reason,
					scope,
					current_depth: scope === 'trigger' ? perTrigger : perWorkspace,
				},
			})
			void trackTriggerQueueOverflow({
				workspaceId: event.workspace_id,
				triggerId: opts.triggerId,
			})
			return 'overflow'
		}

		await db.insert(triggerEventQueue).values({
			workspaceId: event.workspace_id,
			triggerId: opts.triggerId,
			eventId,
			eventSnapshot: event as unknown as Record<string, unknown>,
			replayAfter: opts.replayAfter,
			reason: opts.reason,
		})
	} catch (err) {
		logger.error('Failed to write trigger event queue row — dropping event', {
			workspaceId: event.workspace_id,
			triggerId: opts.triggerId,
			eventId: event.event_id,
			error: String(err),
		})
		try {
			await recordEvent(db, {
				workspaceId: event.workspace_id,
				actorId: event.actor_id,
				action: 'trigger_queue_write_failed',
				entityType: QUEUE_EVENT_ENTITY_TYPE,
				entityId: opts.triggerId ?? event.workspace_id,
				data: { event_id: event.event_id, reason: opts.reason, error: String(err) },
			})
		} catch (recordErr) {
			logger.error('Failed to record trigger_queue_write_failed', { error: String(recordErr) })
		}
		return 'write_failed'
	}

	void trackTriggerEventQueued({
		workspaceId: event.workspace_id,
		triggerId: opts.triggerId,
		eventId: event.event_id,
		reason: opts.reason,
		replayAfter: opts.replayAfter,
	})
	logger.info('Trigger event queued', {
		workspaceId: event.workspace_id,
		triggerId: opts.triggerId,
		eventId: event.event_id,
		reason: opts.reason,
		replayAfter: opts.replayAfter.toISOString(),
	})
	return 'queued'
}

export type DrainScope = { triggerId: string } | { workspaceId: string }

export interface DrainHandlers {
	/** Why this drain is running; a retry_at_x row reports retry_at_x_arrival on the sweep. */
	source: TriggerQueueDrainSource
	/** False when the flag is off for the workspace: rows stay pending for the retention sweep. */
	canReplay: (workspaceId: string) => boolean
	/** True while the trigger / workspace is back inside a window: stop and leave the rest pending. */
	isHeld: (workspaceId: string) => boolean
	/** Re-runs the matcher (or the one trigger) against the stored event. Throws to leave the row pending. */
	replay: (event: PgEvent) => Promise<void>
}

function isPgEventSnapshot(value: unknown): value is PgEvent {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return (
		typeof v.workspace_id === 'string' &&
		typeof v.actor_id === 'string' &&
		typeof v.action === 'string' &&
		typeof v.entity_type === 'string' &&
		typeof v.entity_id === 'string' &&
		typeof v.event_id === 'string'
	)
}

/**
 * Replays pending rows for one trigger, or for one workspace's
 * workspace-suppression rows (trigger_id IS NULL), oldest event first.
 *
 * Each batch claims up to DRAIN_BATCH_SIZE rows with FOR UPDATE SKIP LOCKED
 * inside a transaction and marks a row replayed only after its replay
 * returned, so a crash mid-batch rolls the batch back and the next drain
 * retries it — trigger_dispatches keeps that retry from double-firing (§6.4).
 * Ordering is per trigger by events.id, never by enqueued_at, which can tie.
 *
 * Only rows that existed when the drain began are visited, so a row the replay
 * itself re-queues (the trigger went back into backoff mid-drain) cannot make
 * the loop chase its own tail.
 */
export async function drainQueue(
	db: Database,
	scope: DrainScope,
	handlers: DrainHandlers,
): Promise<number> {
	const scopeWhere =
		'triggerId' in scope
			? eq(triggerEventQueue.triggerId, scope.triggerId)
			: and(
					eq(triggerEventQueue.workspaceId, scope.workspaceId),
					isNull(triggerEventQueue.triggerId),
				)

	const [boundary] = await db
		.select({ maxId: sql<number | null>`max(${triggerEventQueue.id})` })
		.from(triggerEventQueue)
		.where(and(scopeWhere, isNull(triggerEventQueue.replayedAt)))
	const maxId = boundary?.maxId ?? null
	if (maxId === null) return 0

	let replayed = 0
	for (;;) {
		const { done, count } = await db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(triggerEventQueue)
				.where(
					and(scopeWhere, isNull(triggerEventQueue.replayedAt), lte(triggerEventQueue.id, maxId)),
				)
				.orderBy(asc(triggerEventQueue.eventId), asc(triggerEventQueue.id))
				.limit(DRAIN_BATCH_SIZE)
				.for('update', { skipLocked: true })
			if (rows.length === 0) return { done: true, count: 0 }

			let count = 0
			for (const row of rows) {
				if (!handlers.canReplay(row.workspaceId) || handlers.isHeld(row.workspaceId)) {
					return { done: true, count }
				}
				if (isPgEventSnapshot(row.eventSnapshot)) {
					try {
						await handlers.replay(row.eventSnapshot)
					} catch (err) {
						logger.error('Trigger event replay failed — leaving row pending', {
							queueId: row.id,
							eventId: row.eventId,
							triggerId: row.triggerId,
							error: String(err),
						})
						return { done: true, count }
					}
				} else {
					logger.warn('Trigger event queue row has an unusable snapshot — discarding', {
						queueId: row.id,
						eventId: row.eventId,
					})
				}
				const now = new Date()
				await tx
					.update(triggerEventQueue)
					.set({ replayedAt: now })
					.where(eq(triggerEventQueue.id, row.id))
				count++
				void trackTriggerEventReplayed({
					workspaceId: row.workspaceId,
					triggerId: row.triggerId,
					eventId: String(row.eventId),
					drainSource:
						handlers.source === 'sweep' && row.reason === 'retry_at_x'
							? 'retry_at_x_arrival'
							: handlers.source,
					lagSeconds: Math.max(0, Math.round((now.getTime() - row.replayAfter.getTime()) / 1000)),
				})
			}
			return { done: rows.length < DRAIN_BATCH_SIZE, count }
		})
		replayed += count
		if (done) break
	}
	return replayed
}

/** Triggers with pending rows whose replay_after has arrived, oldest window first. */
export async function findDueTriggerIds(db: Database, now: Date): Promise<string[]> {
	const rows = await db
		.selectDistinct({ triggerId: triggerEventQueue.triggerId })
		.from(triggerEventQueue)
		.where(
			and(
				lte(triggerEventQueue.replayAfter, now),
				isNull(triggerEventQueue.replayedAt),
				isNotNull(triggerEventQueue.triggerId),
			),
		)
		.limit(QUEUE_SWEEP_SCOPE_LIMIT)
	return rows.flatMap((r) => (r.triggerId ? [r.triggerId] : []))
}

/** Workspaces with pending workspace-suppression rows whose replay_after has arrived. */
export async function findDueWorkspaceIds(db: Database, now: Date): Promise<string[]> {
	const rows = await db
		.selectDistinct({ workspaceId: triggerEventQueue.workspaceId })
		.from(triggerEventQueue)
		.where(
			and(
				lte(triggerEventQueue.replayAfter, now),
				isNull(triggerEventQueue.replayedAt),
				isNull(triggerEventQueue.triggerId),
			),
		)
		.limit(QUEUE_SWEEP_SCOPE_LIMIT)
	return rows.map((r) => r.workspaceId)
}

/** Deletes rows older than the 7-day retention window, replayed or not. */
export async function sweepQueueRetention(db: Database, now: Date): Promise<void> {
	const cutoff = new Date(now.getTime() - QUEUE_RETENTION_MS)
	await db
		.delete(triggerEventQueue)
		.where(
			or(
				and(isNotNull(triggerEventQueue.replayedAt), lt(triggerEventQueue.replayedAt, cutoff)),
				and(isNull(triggerEventQueue.replayedAt), lt(triggerEventQueue.enqueuedAt, cutoff)),
			),
		)
}
