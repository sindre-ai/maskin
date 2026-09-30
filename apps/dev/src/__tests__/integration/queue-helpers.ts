import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { db } from './global-setup'

// Shared harness for the S3 event-queue integration tests
// (queue-hold-and-replay, queue-per-trigger-fifo, queue-overflow,
// retry-at-x). TriggerRunner runs against real Postgres; only SessionManager
// is stubbed, and events reach it through an EventEmitter standing in for the
// PG NOTIFY bridge, exactly as the S1/S2 integration tests do.

export interface Dispatch {
	actorId: string
	/** events.id of the event the session was dispatched for. */
	eventId: number
}

/** The private surface these tests drive directly; each is what production reaches through an event. */
export interface RunnerInternals {
	suppressWorkspace(
		workspaceId: string,
		suppression: { until: Date; reason: string },
	): Promise<void>
	clearWorkspaceSuppression(workspaceId: string): Promise<void>
	recordTriggerFailure(triggerId: string, reason?: string, until?: Date): Promise<void>
	resetTriggerBackoff(triggerId: string): Promise<void>
	sweepEventQueue(): Promise<void>
	triggerFailures: Map<string, { backoffUntil: Date; reason?: string }>
	workspaceSuppressions: Map<string, { until: Date; reason: string }>
}

export function newQueueRunner() {
	const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
	const dispatches: Dispatch[] = []
	const createSession = vi.fn(async (_workspaceId: string, opts: Record<string, unknown>) => {
		const prompt = String(opts.actionPrompt)
		const event = JSON.parse(prompt.split('Triggering event: ')[1]) as { event_id: string }
		dispatches.push({ actorId: String(opts.actorId), eventId: Number(event.event_id) })
		return { id: randomUUID() }
	})
	const runner = new TriggerRunner(db, bridge, { createSession } as unknown as SessionManager)
	return {
		bridge,
		dispatches,
		runner,
		internals: runner as unknown as RunnerInternals,
	}
}

/** Turns trigger_engine_v2 on for one workspace (or off for all, when null). */
export function setV2Flag(workspaceId: string | null): void {
	process.env.FF_WORKSPACE_FEATURES = workspaceId ? `${workspaceId}:trigger_engine_v2` : undefined
	_resetFeatureFlagConfig()
}

/** Inserts a real events row (so the dispatch path can read it back) and emits it. Returns events.id. */
export async function emitObjectCreated(
	bridge: EventEmitter,
	workspaceId: string,
	actorId: string,
): Promise<number> {
	const entityId = randomUUID()
	const [row] = await db
		.insert(events)
		.values({ workspaceId, actorId, action: 'created', entityType: 'object', entityId, data: {} })
		.returning({ id: events.id })
	const payload: PgEvent = {
		workspace_id: workspaceId,
		actor_id: actorId,
		action: 'created',
		entity_type: 'object',
		entity_id: entityId,
		event_id: String(row.id),
	}
	bridge.emit('event', payload)
	return row.id
}

export async function pollUntil(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await check()) return
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}
