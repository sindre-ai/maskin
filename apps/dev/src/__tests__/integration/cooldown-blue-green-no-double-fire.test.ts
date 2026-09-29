import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, triggerDispatches } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Blue-green double-fire proof for S2 of the trigger-engine fix bet
// (bet/f46b18f7-trigger-engine). Two concurrent trigger-runner instances,
// same DB, same event stream, 100 events — asserts exactly N session
// dispatches thanks to the trigger_dispatches idempotency table
// (INSERT ... ON CONFLICT DO NOTHING), and asserts exactly N rows land in
// the table itself.
//
// **Runs with trigger_engine_v2 OFF** — the whole point is that the
// idempotency guard is unconditional (tech spec §3.4 + §7.3). Load-bearing
// during kill-switch: a flag flip must NOT re-open the blue-green window.
//
// Both runners share one EventEmitter subbed for PgNotifyBridge so every
// emit fans out to both handleEvent listeners, mirroring what happens in
// production when two processes hold the same PG NOTIFY subscription
// during a rolling deploy.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

function makeStubBridge(): EventEmitter & PgNotifyBridge {
	return new EventEmitter() as EventEmitter & PgNotifyBridge
}

function trackingSessionManager() {
	const createSession = vi.fn(async () => ({ id: randomUUID() }))
	return {
		createSession,
		manager: { createSession } as unknown as SessionManager,
	}
}

async function pollUntil<T>(check: () => T | undefined, timeoutMs = 5_000): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = check()
		if (value !== undefined) return value
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	return check()
}

describe('S2 — trigger_dispatches idempotency prevents blue-green double-fire', () => {
	let previousFlagEnv: string | undefined

	beforeEach(() => {
		// Ensure trigger_engine_v2 is OFF for this test — the guard must fire
		// regardless of flag state.
		previousFlagEnv = process.env.FF_WORKSPACE_FEATURES
		process.env.FF_WORKSPACE_FEATURES = undefined
	})

	afterEach(async () => {
		process.env.FF_WORKSPACE_FEATURES = previousFlagEnv ?? undefined
		await db.delete(triggerDispatches)
	})

	it('two concurrent runners against the same DB fire 100 events → exactly 100 dispatches (flag OFF)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const targetActor = await insertActor(db, { type: 'agent', name: 'Blue-green target' })
		const trig = await insertTrigger(db, ws.id, actorId, targetActor.id, {
			name: 'Blue-green trigger — always matches',
			type: 'event',
			enabled: true,
			// Empty filter + only-action check → matches every 'created' event on an
			// object in this workspace. Keeps the setup minimal; the guard is what
			// we're testing, not the matcher.
			config: { entity_type: 'object', action: 'created' },
		})

		// Assert flag really is OFF for this workspace so the test claims what it
		// claims — a stray FF_WORKSPACE_FEATURES value would silently invalidate
		// the "unconditional" part of the proof. `process.env.X = undefined`
		// coerces to the string "undefined", so we can't just check for
		// `.toBeUndefined()`; substring-check the workspace id instead.
		const raw = process.env.FF_WORKSPACE_FEATURES ?? ''
		expect(raw.includes(`${ws.id}:trigger_engine_v2`)).toBe(false)

		const bridge = makeStubBridge()
		const blue = trackingSessionManager()
		const green = trackingSessionManager()
		const runnerBlue = new TriggerRunner(db, bridge, blue.manager)
		const runnerGreen = new TriggerRunner(db, bridge, green.manager)
		await runnerBlue.start()
		await runnerGreen.start()

		const eventIds: number[] = []
		try {
			// Seed 100 events. Each carries a unique event_id (bigserial) but the
			// same trigger + workspace, so the idempotency key is (trig.id, id_N).
			// Also seeds an object per event so the runner's activeSessionId
			// stamping path has somewhere to write (harmless if it fails).
			for (let i = 0; i < 100; i++) {
				const obj = await insertObject(db, ws.id, actorId, {
					type: 'bet',
					title: `blue-green object ${i}`,
				})
				const [row] = await db
					.insert(events)
					.values({
						workspaceId: ws.id,
						actorId,
						action: 'created',
						entityType: 'object',
						entityId: obj.id,
						data: {},
					})
					.returning({ id: events.id, entityId: events.entityId })
				eventIds.push(row.id)

				const payload: PgEvent = {
					workspace_id: ws.id,
					actor_id: actorId,
					action: 'created',
					entity_type: 'object',
					entity_id: row.entityId,
					event_id: String(row.id),
				}
				// Fan out to BOTH runners in the same tick — this is the blue-green
				// overlap. Each runner independently races on the INSERT.
				bridge.emit('event', payload)
			}

			// Wait until the total number of createSession calls plus dedup skips
			// equals 100 — every event either lands as a dispatch on ONE runner or
			// gets swallowed by the guard on both. Race can leave a few in-flight
			// milliseconds after emit, hence the poll.
			await pollUntil(() => {
				const rows = blue.createSession.mock.calls.length + green.createSession.mock.calls.length
				return rows >= 100 ? true : undefined
			})
			// Small quiescence window so any tail dedup awaits (the analytics event
			// fires after the return path) settle before we assert.
			await new Promise((resolve) => setTimeout(resolve, 200))
		} finally {
			await runnerBlue.stop()
			await runnerGreen.stop()
		}

		// Exactly 100 dispatches total across both runners — no double-fire.
		const totalDispatches =
			blue.createSession.mock.calls.length + green.createSession.mock.calls.length
		expect(totalDispatches).toBe(100)

		// Exactly 100 idempotency rows persisted — proves the guard is the reason
		// double-fire is prevented, not some accidental serialisation upstream.
		const rows = await db
			.select({ id: triggerDispatches.eventId })
			.from(triggerDispatches)
			.where(eq(triggerDispatches.triggerId, trig.id))
		expect(rows.length).toBe(100)

		// One dispatch row per event id — the number of DB rows AND the number
		// of dispatch calls agree, so no dispatch happened without a row and no
		// row happened without a dispatch.
		const dispatchedEventIds = new Set(rows.map((r) => r.id))
		expect(dispatchedEventIds.size).toBe(100)
		for (const eid of eventIds) {
			expect(dispatchedEventIds.has(eid)).toBe(true)
		}

		// Isolation across test files is handled by global-setup's beforeEach
		// TRUNCATE; no per-test cleanup needed here.
	})
})
