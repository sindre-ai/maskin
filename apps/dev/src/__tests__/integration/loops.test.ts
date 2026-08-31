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
			status: 'learning',
			title: 'Foreign loop',
		})

		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
			title: 'Customer feedback',
			content: 'Every customer who gives feedback hears back within 30 days',
			metadata: {
				entry_condition: 'A new customer feedback item lands in the inbox',
				close_condition: 'A personalised reply is sent within 30 days',
			},
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			loops: Array<{
				id: string
				name: string
				content: string
				status: string
				pill: string
				entryCondition: string
				closeCondition: string
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
		expect(row.content).toBe('Every customer who gives feedback hears back within 30 days')
		expect(row.status).toBe('learning')
		expect(row.pill).toBe('learning')
		expect(row.entryCondition).toBe('A new customer feedback item lands in the inbox')
		expect(row.closeCondition).toBe('A personalised reply is sent within 30 days')
		expect(row.inProgressCount).toBe(0)
		expect(row.closedCount).toBe(0)
		expect(row.agentIds).toEqual([])
		expect(row.triggerIds).toEqual([])
		expect(row.waitingOnViewer).toBe(false)
	})

	it('scopes to a single loop when `id` is passed (used by get_loop)', async () => {
		const loop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
			title: 'Wanted loop',
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
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
			status: 'learning',
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
			status: 'learning',
			title: 'Bug intake',
		})
		const otherLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
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
			status: 'learning',
			title: 'Lead qualification',
			metadata: { closed_statuses: { lead: ['won', 'lost'] } },
		})
		const openLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
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
			status: 'learning',
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
			status: 'learning',
			title: 'Median timing',
		})
		const openLoop = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
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
			status: 'learning',
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
			status: 'learning',
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
		const otherActor = await insertActor(db)

		const draft = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'draft',
			title: 'Draft loop',
		})
		const learning = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'learning',
			title: 'Learning loop',
		})
		const supervised = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'supervised',
			title: 'Supervised loop',
		})
		const fullyAutonomous = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'fully_autonomous',
			title: 'Fully autonomous loop',
		})
		const paused = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'paused',
			title: 'Paused loop',
		})

		// A live loop with unread activity on a member object — this is the only
		// way to reach `waiting_on_you` now that there's no explicit `waiting`
		// status; it overrides the autonomy-stage label for live statuses only.
		const waiting = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'supervised',
			title: 'Waiting loop',
		})
		const waitingChild = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_review',
			title: 'Needs a look',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: waiting.id,
			targetType: 'object',
			targetId: waitingChild.id,
			type: 'in_loop',
		})
		await db.insert(events).values({
			workspaceId,
			actorId: otherActor.id,
			action: 'status_changed',
			entityType: 'task',
			entityId: waitingChild.id,
			data: { status: 'in_review' },
		})

		const app = makeApp(actorId)
		const res = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		const body = (await res.json()) as { loops: Array<{ id: string; pill: string }> }
		const byId = new Map(body.loops.map((r) => [r.id, r]))
		expect(byId.get(draft.id)?.pill).toBe('draft')
		expect(byId.get(learning.id)?.pill).toBe('learning')
		expect(byId.get(supervised.id)?.pill).toBe('supervised')
		expect(byId.get(fullyAutonomous.id)?.pill).toBe('fully_autonomous')
		expect(byId.get(paused.id)?.pill).toBe('paused')
		expect(byId.get(waiting.id)?.pill).toBe('waiting_on_you')
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
				status: 'learning',
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
				status: 'learning',
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
				status: 'learning',
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
			status: 'learning',
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
