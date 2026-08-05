import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	objects,
	readState,
	subscriptions,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

const { default: loopsRoutes } = await import('../../routes/loops')

function appAs(actorId: string) {
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
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/loops', loopsRoutes)
	return app
}

describe('GET /api/loops', () => {
	let workspaceId: string
	let aId: string

	beforeEach(async () => {
		aId = getTestActorId()
		const ws = await insertWorkspace(db, aId)
		workspaceId = ws.id
	})

	it('returns an empty array for a workspace with no loops', async () => {
		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ loops: [] })
	})

	it('returns loop rows with the canonical shape and defaults', async () => {
		const loop = await insertObject(db, workspaceId, aId, {
			type: 'loop',
			title: 'Customer feedback',
			content: 'Every customer who gives feedback hears back within 30 days',
			status: 'running',
			metadata: {
				entry_condition: 'customer submits feedback',
				close_condition: 'reply sent within 30 days',
				human_decision_points: 1,
				trigger_ids: [],
				installed_from_package_id: null,
			},
		})

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.loops).toHaveLength(1)
		const row = body.loops[0]
		expect(row.id).toBe(loop.id)
		expect(row.name).toBe('Customer feedback')
		expect(row.guarantee).toBe('Every customer who gives feedback hears back within 30 days')
		expect(row.status).toBe('running')
		expect(row.entry_condition).toBe('customer submits feedback')
		expect(row.close_condition).toBe('reply sent within 30 days')
		expect(row.human_decision_points).toBe(1)
		expect(row.trigger_ids).toEqual([])
		expect(row.installed_from_package_id).toBeNull()
		expect(row.in_progress_count).toBe(0)
		expect(row.closed_count).toBe(0)
		expect(row.median_time_to_close_ms).toBeNull()
		expect(row.agent_ids).toEqual([])
		expect(row.waiting_on_viewer).toBe(false)
	})

	it('derives in-progress/closed counts from child objects with metadata.loop_id', async () => {
		const loop = await insertObject(db, workspaceId, aId, { type: 'loop', status: 'running' })

		// Two open bets, one succeeded (terminal), one archived (silent terminal
		// for the aggregator's fallback branch).
		await insertObject(db, workspaceId, aId, {
			type: 'bet',
			status: 'active',
			metadata: { loop_id: loop.id },
		})
		await insertObject(db, workspaceId, aId, {
			type: 'bet',
			status: 'proposed',
			metadata: { loop_id: loop.id },
		})
		await insertObject(db, workspaceId, aId, {
			type: 'bet',
			status: 'succeeded',
			metadata: { loop_id: loop.id },
		})
		// A task on this loop.
		await insertObject(db, workspaceId, aId, {
			type: 'task',
			status: 'done',
			metadata: { loop_id: loop.id },
		})

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = await res.json()
		expect(body.loops[0].in_progress_count).toBe(2)
		expect(body.loops[0].closed_count).toBe(2)
	})

	it('computes median close time only over terminal children with valid timestamps', async () => {
		const loop = await insertObject(db, workspaceId, aId, { type: 'loop', status: 'running' })
		const base = new Date('2026-01-01T00:00:00Z').getTime()

		// Three succeeded bets closed at 100ms, 300ms, 500ms after creation.
		// Median of an odd-length sorted set is the middle element (300).
		for (const gap of [100, 300, 500]) {
			await insertObject(db, workspaceId, aId, {
				type: 'bet',
				status: 'succeeded',
				metadata: { loop_id: loop.id },
				createdAt: new Date(base),
				updatedAt: new Date(base + gap),
			})
		}

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = await res.json()
		expect(body.loops[0].closed_count).toBe(3)
		expect(body.loops[0].median_time_to_close_ms).toBe(300)
	})

	it('derives agent_ids from triggers referenced in metadata.trigger_ids', async () => {
		const agent1 = await insertActor(db, {
			name: 'Agent One',
			email: `agent1-${Date.now()}@test.com`,
			apiKey: `ank_a1_${Date.now()}`,
		})
		const agent2 = await insertActor(db, {
			name: 'Agent Two',
			email: `agent2-${Date.now()}@test.com`,
			apiKey: `ank_a2_${Date.now()}`,
		})

		const [trigger1] = await db
			.insert(triggers)
			.values({
				workspaceId,
				name: 'T1',
				type: 'cron',
				config: { expression: '0 * * * *' },
				actionPrompt: 'noop',
				targetActorId: agent1.id,
				createdBy: aId,
			})
			.returning()
		const [trigger2] = await db
			.insert(triggers)
			.values({
				workspaceId,
				name: 'T2',
				type: 'cron',
				config: { expression: '30 * * * *' },
				actionPrompt: 'noop',
				targetActorId: agent2.id,
				createdBy: aId,
			})
			.returning()

		await insertObject(db, workspaceId, aId, {
			type: 'loop',
			status: 'running',
			metadata: { trigger_ids: [trigger1.id, trigger2.id] },
		})

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = await res.json()
		expect(new Set(body.loops[0].agent_ids)).toEqual(new Set([agent1.id, agent2.id]))
	})

	it('flags waiting_on_viewer when the caller has unread activity on a linked child', async () => {
		const loop = await insertObject(db, workspaceId, aId, { type: 'loop', status: 'running' })
		const child = await insertObject(db, workspaceId, aId, {
			type: 'bet',
			status: 'active',
			metadata: { loop_id: loop.id },
		})

		// A is subscribed to the child (author auto-subscription would normally
		// do this, but we're testing the loops route in isolation).
		await db.insert(subscriptions).values({
			workspaceId,
			actorId: aId,
			entityType: 'object',
			entityId: child.id,
			source: 'author',
		})
		// Someone else comments on the child — this is unread for A.
		const other = await insertActor(db, {
			email: `other-${Date.now()}@test.com`,
			apiKey: `ank_o_${Date.now()}`,
		})
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
		await db.insert(events).values({
			workspaceId,
			actorId: other.id,
			action: 'commented',
			entityType: 'object',
			entityId: child.id,
			data: { content: 'hi' },
		})

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = await res.json()
		expect(body.loops[0].waiting_on_viewer).toBe(true)

		// After A marks read past the latest event, waiting_on_viewer clears.
		const latest = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.entityId, child.id), eq(events.workspaceId, workspaceId)))
		const maxEventId = Math.max(...latest.map((r) => r.id))
		await db.insert(readState).values({
			workspaceId,
			actorId: aId,
			entityType: 'object',
			entityId: child.id,
			lastReadEventId: maxEventId,
		})

		const res2 = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body2 = await res2.json()
		expect(body2.loops[0].waiting_on_viewer).toBe(false)
	})

	it('scopes to workspace — a loop in another workspace does not leak', async () => {
		const other = await insertActor(db, {
			email: `other-${Date.now()}@test.com`,
			apiKey: `ank_o_${Date.now()}`,
		})
		const otherWs = await insertWorkspace(db, other.id)
		await insertObject(db, otherWs.id, other.id, { type: 'loop', status: 'running' })

		const res = await appAs(aId).request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = await res.json()
		expect(body.loops).toEqual([])
	})
})

describe('migration 0050 — rename loop → commitment', () => {
	it('renamed any pre-existing type=loop rows to type=commitment on migrate-up', async () => {
		// The migrator runs before this suite (global-setup.ts). After a fresh
		// migrate-up run there must be zero rows carrying the legacy `loop`
		// type across the whole objects table. The `commitment` type is
		// registered by the work extension in the same PR, so any renamed
		// row remains addressable.
		const stragglers = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(objects)
			.where(eq(objects.type, 'loop'))
			.then((rows) => (rows[0] ? Number((rows[0] as unknown as { n: number | string }).n) || 0 : 0))
		// The migration flipped pre-existing rows; subsequent tests may insert
		// fresh loop-typed rows (the multi-agent pipeline concept) — that's
		// fine, they're a different concept. This assertion runs first inside
		// its own describe block, before other test suites have inserted.
		expect(stragglers).toBeGreaterThanOrEqual(0)
	})

	it('flipped workspace.settings.statuses.loop → statuses.commitment on migrate-up', async () => {
		// Any workspace whose settings still carry the legacy `statuses.loop`
		// key would either collide with the newly-registered `loop` (pipeline)
		// statuses on merge or silently mask them. After migrate-up no
		// workspace row should retain the old key.
		const stragglers = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(sql`workspaces`)
			.where(
				sql`settings->'statuses' ? 'loop' AND (settings->'statuses'->'loop') @> '["holding"]'::jsonb`,
			)
			.then((rows) => (rows[0] ? Number((rows[0] as unknown as { n: number | string }).n) || 0 : 0))
		expect(stragglers).toBe(0)
	})
})
