import { triggerEventQueue } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { emitObjectCreated, newQueueRunner, pollUntil, setV2Flag } from './queue-helpers'

// Hold-and-replay proof for S3 of the trigger-engine fix bet (bet #6: events
// dropped instead of queued). Real Postgres, real TriggerRunner.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

function posthogCalls(event: string) {
	return vi
		.mocked(capturePosthogEvent)
		.mock.calls.filter(([name]) => name === event)
		.map(([, , props]) => props)
}

describe('S3 — event queue holds events for a suppressed workspace and replays them', () => {
	afterEach(() => {
		setV2Flag(null)
		vi.mocked(capturePosthogEvent).mockClear()
	})

	async function seedWorkspaceWithTrigger() {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const target = await insertActor(db, { type: 'agent', name: 'Queue target' })
		await insertTrigger(db, ws.id, actorId, target.id, {
			name: 'Queue hold-and-replay trigger',
			type: 'event',
			config: { entity_type: 'object', action: 'created' },
		})
		return { actorId, ws, target }
	}

	it('suppress workspace, fire 10 events, unsuppress: all 10 dispatch in event_id order', async () => {
		const { actorId, ws, target } = await seedWorkspaceWithTrigger()
		setV2Flag(ws.id)
		const { bridge, dispatches, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.suppressWorkspace(ws.id, {
				until: new Date(Date.now() + 60 * 60_000),
				reason: 'no LLM credentials connected for this workspace',
			})

			const eventIds: number[] = []
			for (let i = 0; i < 10; i++) eventIds.push(await emitObjectCreated(bridge, ws.id, actorId))

			await pollUntil(async () => {
				const rows = await db
					.select()
					.from(triggerEventQueue)
					.where(eq(triggerEventQueue.workspaceId, ws.id))
				return rows.length === 10
			})
			const held = await db
				.select()
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.workspaceId, ws.id))
			expect(held.every((r) => r.triggerId === null && r.reason === 'workspace_suppression')).toBe(
				true,
			)
			expect(held.every((r) => r.replayedAt === null)).toBe(true)
			expect(dispatches).toHaveLength(0)

			await internals.clearWorkspaceSuppression(ws.id)
			await pollUntil(() => dispatches.length === 10)

			// Same order the events happened in, not the order they were queued in.
			expect(dispatches.map((d) => d.eventId)).toEqual([...eventIds].sort((a, b) => a - b))
			expect(dispatches.every((d) => d.actorId === target.id)).toBe(true)
			await pollUntil(async () => {
				const pending = await db
					.select()
					.from(triggerEventQueue)
					.where(
						and(eq(triggerEventQueue.workspaceId, ws.id), isNull(triggerEventQueue.replayedAt)),
					)
				return pending.length === 0
			})

			// Paired PostHog events, one per row, with the documented property shapes.
			expect(posthogCalls('trigger_event_queued')).toHaveLength(10)
			expect(posthogCalls('trigger_event_replayed')).toHaveLength(10)
			expect(posthogCalls('trigger_event_queued')[0]).toMatchObject({
				workspace_id: ws.id,
				trigger_id: null,
				reason: 'workspace_suppression',
			})
			expect(posthogCalls('trigger_event_replayed')[0]).toMatchObject({
				workspace_id: ws.id,
				drain_source: 'workspace_unsuppress',
			})
		} finally {
			await runner.stop()
		}
	})

	it('drops the events, exactly as before, when trigger_engine_v2 is off', async () => {
		const { actorId, ws } = await seedWorkspaceWithTrigger()
		setV2Flag(null)
		const { bridge, dispatches, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.suppressWorkspace(ws.id, {
				until: new Date(Date.now() + 60 * 60_000),
				reason: 'no LLM credentials connected for this workspace',
			})
			for (let i = 0; i < 3; i++) await emitObjectCreated(bridge, ws.id, actorId)
			await new Promise((resolve) => setTimeout(resolve, 500))

			const rows = await db
				.select()
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.workspaceId, ws.id))
			expect(rows).toHaveLength(0)
			expect(dispatches).toHaveLength(0)
		} finally {
			await runner.stop()
		}
	})

	it('leaves held events pending while the workspace is still suppressed', async () => {
		const { actorId, ws } = await seedWorkspaceWithTrigger()
		setV2Flag(ws.id)
		const { bridge, dispatches, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.suppressWorkspace(ws.id, {
				until: new Date(Date.now() + 60 * 60_000),
				reason: 'no LLM credentials connected for this workspace',
			})
			await emitObjectCreated(bridge, ws.id, actorId)
			await pollUntil(async () => {
				const rows = await db
					.select()
					.from(triggerEventQueue)
					.where(eq(triggerEventQueue.workspaceId, ws.id))
				return rows.length === 1
			})

			// The sweep only visits rows whose replay_after has arrived (1h out here).
			await internals.sweepEventQueue()
			expect(dispatches).toHaveLength(0)
		} finally {
			await runner.stop()
		}
	})
})
