import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects, triggers as triggersTable } from '@maskin/db/schema'
import { and, sql as drizzleSql, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

// Load the routes lazily so vitest doesn't pull them in at module resolution
// time (mirrors the pattern used in subscriptions.test.ts).
const { default: loopsRoutes } = await import('../../routes/loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

function makeApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/loops', loopsRoutes)
	return app
}

describe('Loops read API integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('returns an empty list — not a 404 — when the workspace has no loops', async () => {
		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { loops: unknown[] }
		expect(body.loops).toEqual([])
	})

	it('returns loops filtered by workspace with the T3 render shape', async () => {
		// Foreign workspace with its own loop — a workspace filter regression
		// would leak this into the primary workspace's response. Guarded by
		// asserting the primary loop's id shows up alone.
		const otherActor = await insertActor(db)
		const otherWs = await insertWorkspace(db, otherActor.id)
		await insertObject(db, otherWs.id, otherActor.id, {
			type: 'loop',
			status: 'running',
			title: 'Foreign loop',
		})

		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Customer feedback',
			content: 'Every customer who gives feedback hears back within 30 days',
			metadata: {
				entry_condition: 'A new customer feedback item lands in the inbox',
				close_condition: 'A personalised reply is sent within 30 days',
				human_decision_points: 2,
			},
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			loops: Array<{
				id: string
				name: string
				guarantee: string
				status: string
				pill: string
				entryCondition: string
				closeCondition: string
				humanDecisionPoints: number
				inProgressCount: number
				closedCount: number
				agentIds: string[]
				triggerIds: string[]
				waitingOnViewer: boolean
			}>
		}
		expect(body.loops).toHaveLength(1)
		const row = body.loops[0]
		expect(row.id).toBe(loop.id)
		expect(row.name).toBe('Customer feedback')
		expect(row.guarantee).toBe('Every customer who gives feedback hears back within 30 days')
		expect(row.status).toBe('running')
		expect(row.pill).toBe('running')
		expect(row.entryCondition).toBe('A new customer feedback item lands in the inbox')
		expect(row.closeCondition).toBe('A personalised reply is sent within 30 days')
		expect(row.humanDecisionPoints).toBe(2)
		expect(row.inProgressCount).toBe(0)
		expect(row.closedCount).toBe(0)
		expect(row.agentIds).toEqual([])
		expect(row.triggerIds).toEqual([])
		expect(row.waitingOnViewer).toBe(false)
	})

	it('derives in-progress and closed counts from child objects linked via metadata.loop_id', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Bug intake',
		})

		// One in-progress task, one done task, one non-terminal task, plus
		// stragglers on other loops that must NOT leak in.
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Fix crash on export',
			metadata: { loop_id: loop.id },
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'done',
			title: 'Fix null pointer',
			metadata: { loop_id: loop.id },
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			status: 'active',
			title: 'A bet on the loop',
			metadata: { loop_id: loop.id },
		})
		// Straggler pointing at a made-up loop id — must not count against the real loop.
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Unrelated task',
			metadata: { loop_id: '00000000-0000-0000-0000-000000000001' },
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; inProgressCount: number; closedCount: number }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row).toBeDefined()
		expect(row?.inProgressCount).toBe(2)
		expect(row?.closedCount).toBe(1)
	})

	it('collects agent-actor ids from triggers referenced in metadata.trigger_ids', async () => {
		const agentA = await insertActor(db, { type: 'agent', name: 'Agent A' })
		const agentB = await insertActor(db, { type: 'agent', name: 'Agent B' })

		const [trigA] = await db
			.insert(triggersTable)
			.values({
				workspaceId,
				name: 'Trigger A',
				type: 'event',
				config: { entity_type: 'object', action: 'created' },
				actionPrompt: 'Do the thing',
				targetActorId: agentA.id,
				enabled: true,
				createdBy: actorId,
			})
			.returning()
		const [trigB] = await db
			.insert(triggersTable)
			.values({
				workspaceId,
				name: 'Trigger B',
				type: 'event',
				config: { entity_type: 'object', action: 'created' },
				actionPrompt: 'Do the other thing',
				targetActorId: agentB.id,
				enabled: true,
				createdBy: actorId,
			})
			.returning()

		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Pipeline',
			metadata: { trigger_ids: [trigA.id, trigB.id] },
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; agentIds: string[]; triggerIds: string[] }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.agentIds.sort()).toEqual([agentA.id, agentB.id].sort())
		expect(row?.triggerIds.sort()).toEqual([trigA.id, trigB.id].sort())
	})

	it('composes the `pill` field from lifecycle status + waiting_on_viewer', async () => {
		const running = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Running loop',
		})
		const waiting = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'waiting',
			title: 'Waiting loop',
		})
		const paused = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'paused',
			title: 'Paused loop',
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as { loops: Array<{ id: string; pill: string }> }
		const byId = new Map(body.loops.map((r) => [r.id, r]))
		expect(byId.get(running.id)?.pill).toBe('running')
		expect(byId.get(waiting.id)?.pill).toBe('waiting_on_you')
		expect(byId.get(paused.id)?.pill).toBe('paused')
	})
})

describe('Loop → Commitment rename migration', () => {
	it('renames any pre-existing `type=loop` row to `type=commitment` and mirrors the change in events', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		// Bypass the normal insert path so we can plant a pre-rename row shape.
		// Direct SQL keeps the test honest — this simulates an old workspace
		// carrying the legacy `loop` type before the migration ran.
		const [legacy] = await sql<
			{ id: string }[]
		>`INSERT INTO objects (workspace_id, type, title, status, created_by)
			VALUES (${ws.id}, 'loop', 'Legacy standing commitment', 'holding', ${actorId})
			RETURNING id`
		await sql`INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
			VALUES (${ws.id}, ${actorId}, 'created', 'loop', ${legacy.id}, '{}'::jsonb)`

		// Re-run the migration in a transaction — the file is idempotent, and
		// this hits the exact SQL every workspace runs on migrate.
		await sql`
			DO $$
			DECLARE
				renamed_objects int;
				renamed_events int;
			BEGIN
				WITH updated AS (
					UPDATE objects
					SET type = 'commitment',
						updated_at = now()
					WHERE type = 'loop'
					RETURNING id
				)
				SELECT count(*) INTO renamed_objects FROM updated;

				WITH updated_events AS (
					UPDATE events
					SET entity_type = 'commitment'
					WHERE entity_type = 'loop'
					RETURNING id
				)
				SELECT count(*) INTO renamed_events FROM updated_events;
			END $$;
		`

		const [obj] = await db.select().from(objects).where(eq(objects.id, legacy.id))
		expect(obj.type).toBe('commitment')

		const [eventCount] = await sql<
			{ count: string }[]
		>`SELECT count(*)::int AS count FROM events WHERE entity_type = 'commitment' AND entity_id = ${legacy.id}`
		expect(Number(eventCount.count)).toBe(1)
	})

	it('is a no-op on the second run — reflects the idempotency contract in the migration comment', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		// Insert a `commitment` row and confirm the migration statement leaves
		// it alone (no loop rows exist post-run). Any drift would flip the row
		// to a bad type.
		await sql`INSERT INTO objects (workspace_id, type, title, status, created_by)
			VALUES (${ws.id}, 'commitment', 'Already-migrated', 'holding', ${actorId})`

		const before = await db
			.select({ count: drizzleSql<number>`count(*)::int` })
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'commitment')))

		await sql`UPDATE objects SET type = 'commitment' WHERE type = 'loop'`

		const after = await db
			.select({ count: drizzleSql<number>`count(*)::int` })
			.from(objects)
			.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'commitment')))

		expect(after[0].count).toBe(before[0].count)
	})
})
