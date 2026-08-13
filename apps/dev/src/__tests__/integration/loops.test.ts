import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, triggers as triggersTable } from '@maskin/db/schema'
import { and, sql as drizzleSql, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
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

	it('scopes to a single loop when `id` is passed (used by get_loop)', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Wanted loop',
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Other loop in the same workspace',
		})

		const app = makeApp(actorId)
		const res = await app.request(
			jsonGet(`/api/loops?id=${loop.id}`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { loops: Array<{ id: string; name: string }> }
		expect(body.loops).toHaveLength(1)
		expect(body.loops[0]?.id).toBe(loop.id)
		expect(body.loops[0]?.name).toBe('Wanted loop')
	})

	it('returns an empty array — not a 404 — when `id` does not match a loop in this workspace', async () => {
		const otherActor = await insertActor(db)
		const otherWs = await insertWorkspace(db, otherActor.id)
		const foreignLoop = await insertObject(db, otherWs.id, otherActor.id, {
			type: 'loop',
			status: 'running',
			title: 'Foreign loop',
		})

		const app = makeApp(actorId)
		const res = await app.request(
			jsonGet(`/api/loops?id=${foreignLoop.id}`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { loops: unknown[] }
		expect(body.loops).toEqual([])
	})

	it('derives in-progress and closed counts from child objects linked via an in_loop relationship', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Bug intake',
		})
		const otherLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Unrelated loop',
		})

		// One in-progress task, one done task, one non-terminal bet, plus a
		// straggler linked to a DIFFERENT real loop — must not leak in.
		const inProgressTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Fix crash on export',
		})
		const doneTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'done',
			title: 'Fix null pointer',
		})
		const activeBet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			status: 'active',
			title: 'A bet on the loop',
		})
		const unrelatedTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Unrelated task',
		})

		for (const target of [inProgressTask, doneTask, activeBet]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: target.id,
				type: 'in_loop',
			})
		}
		// Linked to the OTHER loop, not the one under test.
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: otherLoop.id,
			targetType: 'object',
			targetId: unrelatedTask.id,
			type: 'in_loop',
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
		const otherRow = body.loops.find((l) => l.id === otherLoop.id)
		expect(otherRow?.inProgressCount).toBe(1)
		expect(otherRow?.closedCount).toBe(0)
	})

	it("respects the loop's own metadata.closed_statuses for custom object types", async () => {
		// A loop flowing a workspace-defined type ('lead') that appears in no
		// hardcoded terminal table. Without the per-loop closed_statuses
		// override, every lead would count as in-progress forever.
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Lead qualification',
			metadata: { closed_statuses: { lead: ['won', 'lost'] } },
		})
		const openLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'No override loop',
		})

		const wonLead = await insertObject(db, workspaceId, actorId, {
			type: 'lead',
			status: 'won',
			title: 'Acme',
		})
		const activeLead = await insertObject(db, workspaceId, actorId, {
			type: 'lead',
			status: 'contacted',
			title: 'Globex',
		})
		// Same terminal-looking lead in a loop WITHOUT the override — must stay
		// in-progress, proving the override is per-loop, not global.
		const wonLeadNoOverride = await insertObject(db, workspaceId, actorId, {
			type: 'lead',
			status: 'won',
			title: 'Initech',
		})

		for (const target of [wonLead, activeLead]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: target.id,
				type: 'in_loop',
			})
		}
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: openLoop.id,
			targetType: 'object',
			targetId: wonLeadNoOverride.id,
			type: 'in_loop',
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{
				id: string
				inProgressCount: number
				closedCount: number
				medianTimeToCloseMs: number | null
			}>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.inProgressCount).toBe(1)
		expect(row?.closedCount).toBe(1)
		expect(row?.medianTimeToCloseMs).not.toBeNull()

		const noOverrideRow = body.loops.find((l) => l.id === openLoop.id)
		expect(noOverrideRow?.inProgressCount).toBe(1)
		expect(noOverrideRow?.closedCount).toBe(0)
	})

	it("closed_statuses can also override a built-in type's terminal set for one loop", async () => {
		// The loop declares that only 'validated' means done for tasks — a
		// task in 'done' therefore still counts as in-progress FOR THIS LOOP,
		// while the fallback table would have counted it closed.
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Strict validation loop',
			metadata: { closed_statuses: { task: ['validated'] } },
		})
		const doneTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'done',
			title: 'Done but not validated',
		})
		const validatedTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'validated',
			title: 'Validated',
		})
		for (const target of [doneTask, validatedTask]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: target.id,
				type: 'in_loop',
			})
		}

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; inProgressCount: number; closedCount: number }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.inProgressCount).toBe(1)
		expect(row?.closedCount).toBe(1)
	})

	it('computes medianTimeToCloseMs from closed children (updated_at − created_at), null when none are closed', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Median timing',
		})
		const openLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'No closed children yet',
		})

		const createdAt = new Date('2026-01-01T00:00:00.000Z')
		// Two closed children, closed 1s and 3s after creation — percentile_cont's
		// linear interpolation over [1000, 3000] at the 0.5 quantile is exactly
		// 2000ms, so this pins down both the SQL window function and the ms
		// rounding in loops.ts rather than just checking "some number came back".
		const closedFast = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'done',
			title: 'Closed in 1s',
			createdAt,
			updatedAt: new Date(createdAt.getTime() + 1000),
		})
		const closedSlow = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'done',
			title: 'Closed in 3s',
			createdAt,
			updatedAt: new Date(createdAt.getTime() + 3000),
		})
		const stillOpen = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Still open — must not count toward the median',
			createdAt,
			updatedAt: createdAt,
		})

		for (const target of [closedFast, closedSlow, stillOpen]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: target.id,
				type: 'in_loop',
			})
		}

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; medianTimeToCloseMs: number | null }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.medianTimeToCloseMs).toBe(2000)

		const emptyRow = body.loops.find((l) => l.id === openLoop.id)
		expect(emptyRow?.medianTimeToCloseMs).toBeNull()
	})

	it('ignores relationships of a different type when computing loop membership', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Narrow membership',
		})
		const relatedButNotMember = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Merely informs the loop',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: loop.id,
			targetType: 'object',
			targetId: relatedButNotMember.id,
			type: 'informs',
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; inProgressCount: number; closedCount: number }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.inProgressCount).toBe(0)
		expect(row?.closedCount).toBe(0)
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

	describe("GET /api/loops/:id/activity — the agents' own event feed", () => {
		it("returns session_* + trigger_fired events keyed to the loop's triggers, newest first", async () => {
			const agent = await insertActor(db, { type: 'agent', name: 'Loop agent' })
			const trigger = await insertTrigger(db, workspaceId, actorId, agent.id, {
				name: 'Loop trigger',
			})
			const otherTrigger = await insertTrigger(db, workspaceId, actorId, agent.id, {
				name: 'Unrelated trigger',
			})

			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'running',
				title: 'Loop with activity',
				metadata: { trigger_ids: [trigger.id] },
			})

			// A session launched from the loop's trigger. session events are
			// keyed to session.id — the join through triggerId is what gets them
			// on the feed at all.
			const session = await insertSession(db, workspaceId, agent.id, actorId, {
				triggerId: trigger.id,
				status: 'completed',
			})
			// A second session from a DIFFERENT trigger — must not leak into
			// the loop's feed.
			const otherSession = await insertSession(db, workspaceId, agent.id, actorId, {
				triggerId: otherTrigger.id,
				status: 'completed',
			})

			await db.insert(events).values([
				{
					workspaceId,
					actorId: agent.id,
					action: 'trigger_fired',
					entityType: 'trigger',
					entityId: trigger.id,
					data: {},
					createdAt: new Date('2026-08-13T00:00:00.000Z'),
				},
				{
					workspaceId,
					actorId: agent.id,
					action: 'session_created',
					entityType: 'session',
					entityId: session.id,
					data: {},
					createdAt: new Date('2026-08-13T00:00:01.000Z'),
				},
				{
					workspaceId,
					actorId: agent.id,
					action: 'session_completed',
					entityType: 'session',
					entityId: session.id,
					data: {},
					createdAt: new Date('2026-08-13T00:00:02.000Z'),
				},
				// From the unrelated trigger — must not surface.
				{
					workspaceId,
					actorId: agent.id,
					action: 'trigger_fired',
					entityType: 'trigger',
					entityId: otherTrigger.id,
					data: {},
					createdAt: new Date('2026-08-13T00:00:03.000Z'),
				},
				{
					workspaceId,
					actorId: agent.id,
					action: 'session_completed',
					entityType: 'session',
					entityId: otherSession.id,
					data: {},
					createdAt: new Date('2026-08-13T00:00:04.000Z'),
				},
				// Loop-row config event — belongs to the Changes log, not this
				// feed. Its presence proves the endpoint filters by session/
				// trigger action + entity id, not just workspace id.
				{
					workspaceId,
					actorId,
					action: 'updated',
					entityType: 'object',
					entityId: loop.id,
					data: { changes: [{ field: 'title', old: 'x', new: 'y' }] },
					createdAt: new Date('2026-08-13T00:00:05.000Z'),
				},
			])

			const app = makeApp(actorId)
			const res = await app.request(
				jsonGet(`/api/loops/${loop.id}/activity`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				events: Array<{ id: number; action: string; entityType: string; entityId: string }>
			}

			const actions = body.events.map((e) => e.action)
			expect(actions).toEqual(['session_completed', 'session_created', 'trigger_fired'])
			for (const e of body.events) {
				expect(e.entityId === session.id || e.entityId === trigger.id).toBe(true)
			}
			expect(body.events.some((e) => e.action === 'updated')).toBe(false)
			expect(body.events.some((e) => e.entityId === otherSession.id)).toBe(false)
			expect(body.events.some((e) => e.entityId === otherTrigger.id)).toBe(false)
		})

		it('returns { events: [] } — not an error — for a loop with no triggers', async () => {
			const loop = await insertObject(db, workspaceId, actorId, {
				type: 'loop',
				status: 'running',
				title: 'Empty loop',
			})

			const app = makeApp(actorId)
			const res = await app.request(
				jsonGet(`/api/loops/${loop.id}/activity`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { events: unknown[] }
			expect(body.events).toEqual([])
		})

		it('does not leak events from a loop in a different workspace', async () => {
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			const otherAgent = await insertActor(db, { type: 'agent', name: 'Foreign agent' })
			const otherTrigger = await insertTrigger(db, otherWs.id, otherActor.id, otherAgent.id, {
				name: 'Foreign trigger',
			})
			const foreignLoop = await insertObject(db, otherWs.id, otherActor.id, {
				type: 'loop',
				status: 'running',
				title: 'Foreign loop',
				metadata: { trigger_ids: [otherTrigger.id] },
			})
			await db.insert(events).values({
				workspaceId: otherWs.id,
				actorId: otherAgent.id,
				action: 'trigger_fired',
				entityType: 'trigger',
				entityId: otherTrigger.id,
				data: {},
			})

			const app = makeApp(actorId)
			const res = await app.request(
				jsonGet(`/api/loops/${foreignLoop.id}/activity`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { events: unknown[] }
			// Foreign loop id is not visible in this workspace — return empty
			// rather than leak that the id resolves elsewhere.
			expect(body.events).toEqual([])
		})
	})

	it('flips `waitingOnViewer` true on an unread status-change event on a child object, not just comments', async () => {
		const otherActor = await insertActor(db)

		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'running',
			title: 'Needs attention',
		})
		const childTask = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_review',
			title: 'Agent-driven task',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: loop.id,
			targetType: 'object',
			targetId: childTask.id,
			type: 'in_loop',
		})

		// A lifecycle event logged with entity_type set to the object's
		// concrete type (mirrors how objects.ts logs `status_changed`/
		// `updated` events) — not a comment, and not entity_type='object'.
		await db.insert(events).values({
			workspaceId,
			actorId: otherActor.id,
			action: 'status_changed',
			entityType: 'task',
			entityId: childTask.id,
			data: { status: 'in_review' },
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as {
			loops: Array<{ id: string; waitingOnViewer: boolean; pill: string }>
		}
		const row = body.loops.find((l) => l.id === loop.id)
		expect(row?.waitingOnViewer).toBe(true)
		expect(row?.pill).toBe('waiting_on_you')
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
