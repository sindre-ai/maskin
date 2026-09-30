// §9.4 self-heal against real Postgres. The mocked-DB unit file seeds every
// row with a completedAt, which hid that a paused row (completedAt null per
// §5.2 col 2) was never selected. This drives the real query end to end.

import { events } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { settleSession } from '../../services/session-lifecycle'
import { SELF_HEAL_GRACE_MS, SessionReconciler } from '../../services/session-reconciler'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

// db is assigned in global-setup's beforeAll, so build deps lazily.
const makeDeps = () => ({
	db,
	stopSandbox: async () => 'skipped-none-live' as const,
	pushAgentFiles: async () => 'skipped-no-workspace' as const,
})

describe('SessionReconciler.selfHealTerminalWithoutEvents — real Postgres', () => {
	for (const [kind, action] of [
		['pause', 'session_paused'],
		['complete', 'session_completed'],
	] as const) {
		it(`back-fills a missing ${action} row (${kind} settle)`, async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const session = await insertSession(db, ws.id, actorId, actorId, { status: 'running' })
			await settleSession(
				session.id,
				{
					kind,
					classification: kind === 'pause' ? 'idle_timeout' : 'agent_completed',
					source: 'sandbox-exit',
				},
				makeDeps(),
			)
			// Simulate the lost post-commit write: drop the events row settleSession emitted.
			await db
				.delete(events)
				.where(and(eq(events.entityType, 'session'), eq(events.entityId, session.id)))

			const reconciler = new SessionReconciler(db)
			const result = await reconciler.selfHealTerminalWithoutEvents(
				Date.now() + SELF_HEAL_GRACE_MS + 5_000,
			)
			expect(result.backFilled).toEqual([{ sessionId: session.id, action }])

			const rows = await db
				.select({ id: events.id })
				.from(events)
				.where(
					and(
						eq(events.entityType, 'session'),
						eq(events.entityId, session.id),
						eq(events.action, action),
					),
				)
			expect(rows).toHaveLength(1)

			// Idempotent: a second pass finds nothing to heal for this session.
			const again = await reconciler.selfHealTerminalWithoutEvents(
				Date.now() + SELF_HEAL_GRACE_MS + 5_000,
			)
			expect(again.backFilled.filter((b) => b.sessionId === session.id)).toEqual([])
		})
	}

	it('leaves a terminal session alone while inside the grace window', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const session = await insertSession(db, ws.id, actorId, actorId, { status: 'running' })
		await settleSession(
			session.id,
			{ kind: 'pause', classification: 'idle_timeout', source: 'sandbox-exit' },
			makeDeps(),
		)
		await db
			.delete(events)
			.where(and(eq(events.entityType, 'session'), eq(events.entityId, session.id)))

		const result = await new SessionReconciler(db).selfHealTerminalWithoutEvents(Date.now())
		expect(result.backFilled.filter((b) => b.sessionId === session.id)).toEqual([])
	})

	it('honours a caller-provided graceMs against the real cutoff', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const session = await insertSession(db, ws.id, actorId, actorId, { status: 'running' })
		await settleSession(
			session.id,
			{ kind: 'fail', classification: 'sandbox_crash', source: 'sandbox-exit' },
			makeDeps(),
		)
		await db
			.delete(events)
			.where(and(eq(events.entityType, 'session'), eq(events.entityId, session.id)))

		const reconciler = new SessionReconciler(db)
		const nowMs = Date.now() + 10_000
		// Default 60s grace: settled ~10s ago, still inside the window.
		const inside = await reconciler.selfHealTerminalWithoutEvents(nowMs, SELF_HEAL_GRACE_MS)
		expect(inside.backFilled.filter((b) => b.sessionId === session.id)).toEqual([])
		// 5s grace: the same row is now outside the window and gets healed.
		const outside = await reconciler.selfHealTerminalWithoutEvents(nowMs, 5_000)
		expect(outside.backFilled.filter((b) => b.sessionId === session.id)).toEqual([
			{ sessionId: session.id, action: 'session_failed' },
		])
	})
})
