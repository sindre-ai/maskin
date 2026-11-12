import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, nextSteps } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { findObjectsNeedingNextStep } from '../../lib/next-steps'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: nextStepRoutes } = await import('../../routes/object-next-step')
const { default: objectRoutes } = await import('../../routes/objects')

/**
 * The next step on a driven object, against real Postgres: one open or blocked step per
 * object, a blocked step names exactly one thing it waits on, every write leaves an audit
 * event, and one query finds the driven objects that are late or have no step.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appAs(actorId: string, actorType = 'human') {
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
		c.set('actorType', actorType)
		await next()
	})
	app.route('/api/objects', nextStepRoutes as never)
	app.route('/api/objects', objectRoutes as never)
	return app
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function setup() {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent', name: 'Owner agent' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	const bet = await insertObject(db, workspace.id, human, {
		type: 'bet',
		status: 'active',
		driver: agent.id,
	})
	return { human, workspace, agent, bet }
}

async function post(actorId: string, objectId: string, body: unknown) {
	return appAs(actorId, 'agent').request(
		jsonRequest('POST', `/api/objects/${objectId}/next-step`, body),
	)
}

async function patch(actorId: string, objectId: string, body: unknown) {
	return appAs(actorId, 'agent').request(
		jsonRequest('PATCH', `/api/objects/${objectId}/next-step`, body),
	)
}

describe('setting the next step', () => {
	it('stores the step with the caller as owner and records an audit event', async () => {
		const { agent, bet, workspace } = await setup()
		const due = inDays(1)
		const res = await post(agent.id, bet.id, { action: 'Read the sign-up numbers', due_at: due })
		expect(res.status).toBe(201)
		const step = (await res.json()) as Record<string, unknown>
		expect(step).toMatchObject({
			object_id: bet.id,
			action: 'Read the sign-up numbers',
			owner_id: agent.id,
			status: 'open',
			created_by: agent.id,
		})

		const [event] = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, bet.id),
					eq(events.action, 'next_step_set'),
					eq(events.workspaceId, workspace.id),
				),
			)
		expect(event?.actorId).toBe(agent.id)
	})

	it('refuses a second open step on the same object, and replaces on request', async () => {
		const { agent, bet } = await setup()
		const first = await post(agent.id, bet.id, { action: 'First', due_at: inDays(1) })
		expect(first.status).toBe(201)

		const second = await post(agent.id, bet.id, { action: 'Second', due_at: inDays(2) })
		expect(second.status).toBe(409)

		const replaced = await post(agent.id, bet.id, {
			action: 'Second',
			due_at: inDays(2),
			replace: true,
		})
		expect(replaced.status).toBe(201)

		const rows = await db.select().from(nextSteps).where(eq(nextSteps.objectId, bet.id))
		expect(rows.filter((r) => r.status === 'open').map((r) => r.action)).toEqual(['Second'])
		const old = rows.find((r) => r.action === 'First')
		expect(old?.status).toBe('skipped')
		expect(old?.closedAt).not.toBeNull()
	})

	it('also holds in the database: a second live row for one object is rejected', async () => {
		const { agent, bet, workspace } = await setup()
		const values = {
			workspaceId: workspace.id,
			objectId: bet.id,
			action: 'A',
			ownerActorId: agent.id,
			dueAt: new Date(),
		}
		await db.insert(nextSteps).values(values)
		await expect(db.insert(nextSteps).values({ ...values, action: 'B' })).rejects.toThrow()
	})

	it('refuses an owner who is not in the workspace', async () => {
		const { agent, bet } = await setup()
		const stranger = await insertActor(db, { type: 'agent', name: 'Stranger' })
		const res = await post(agent.id, bet.id, {
			action: 'Do it',
			due_at: inDays(1),
			owner_id: stranger.id,
		})
		expect(res.status).toBe(400)
	})
})

describe('a blocked step names exactly one thing it waits on', () => {
	it('refuses blocked on two things, and blocked on an actor with no question', async () => {
		const { agent, bet, human } = await setup()
		const other = await insertObject(db, bet.workspaceId, human, { type: 'task', status: 'todo' })
		const two = await post(agent.id, bet.id, {
			action: 'Wait',
			due_at: inDays(1),
			blocked_on_object_id: other.id,
			blocked_on_actor_id: human,
			blocked_reason: 'both',
		})
		expect(two.status).toBe(400)
		const noQuestion = await post(agent.id, bet.id, {
			action: 'Wait',
			due_at: inDays(1),
			blocked_on_actor_id: human,
		})
		expect(noQuestion.status).toBe(400)
	})

	it('refuses to block an open step with prose alone', async () => {
		const { agent, bet } = await setup()
		await post(agent.id, bet.id, { action: 'Go', due_at: inDays(1) })
		const res = await patch(agent.id, bet.id, {
			status: 'blocked',
			blocked_reason: 'waiting for something',
		})
		expect(res.status).toBe(400)
	})

	it('blocks on an object, then back to open clears what it waited on', async () => {
		const { agent, bet, human } = await setup()
		const blocker = await insertObject(db, bet.workspaceId, human, { type: 'task', status: 'todo' })
		await post(agent.id, bet.id, { action: 'Go', due_at: inDays(1) })

		const blocked = await patch(agent.id, bet.id, {
			status: 'blocked',
			blocked_on_object_id: blocker.id,
		})
		expect(blocked.status).toBe(200)
		expect(await blocked.json()).toMatchObject({
			status: 'blocked',
			blocked_on_object_id: blocker.id,
		})

		const reopened = await patch(agent.id, bet.id, { status: 'open' })
		expect(reopened.status).toBe(200)
		expect(await reopened.json()).toMatchObject({ status: 'open', blocked_on_object_id: null })
	})

	it('an object cannot be blocked on itself', async () => {
		const { agent, bet } = await setup()
		const res = await post(agent.id, bet.id, {
			action: 'Go',
			due_at: inDays(1),
			blocked_on_object_id: bet.id,
		})
		expect(res.status).toBe(400)
	})
})

describe('closing and changing the step', () => {
	it('closes as done with evidence, then the object may take a new step', async () => {
		const { agent, bet } = await setup()
		await post(agent.id, bet.id, { action: 'Ship it', due_at: inDays(1) })

		const noEvidence = await patch(agent.id, bet.id, { status: 'done' })
		expect(noEvidence.status).toBe(400)

		const done = await patch(agent.id, bet.id, { status: 'done', evidence: 'PR merged' })
		expect(done.status).toBe(200)
		expect(await done.json()).toMatchObject({ status: 'done', evidence: 'PR merged' })

		const next = await post(agent.id, bet.id, { action: 'Measure it', due_at: inDays(3) })
		expect(next.status).toBe(201)

		const closedEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, bet.id), eq(events.action, 'next_step_closed')))
		expect(closedEvents).toHaveLength(1)
	})

	it('moves the due time and owner of the open step', async () => {
		const { agent, bet, human } = await setup()
		await post(agent.id, bet.id, { action: 'Go', due_at: inDays(1) })
		const due = inDays(5)
		const res = await patch(agent.id, bet.id, { due_at: due, owner_id: human })
		expect(res.status).toBe(200)
		const step = (await res.json()) as { due_at: string; owner_id: string }
		expect(step.owner_id).toBe(human)
		expect(new Date(step.due_at).toISOString()).toBe(due)
	})

	it('answers 404 when there is no open step to change', async () => {
		const { agent, bet } = await setup()
		const res = await patch(agent.id, bet.id, { action: 'Nothing here' })
		expect(res.status).toBe(404)
	})
})

describe('reading it back', () => {
	it('the single-object read carries next_step, null when there is none', async () => {
		const { agent, bet } = await setup()
		const before = await appAs(agent.id, 'agent').request(jsonGet(`/api/objects/${bet.id}`))
		expect(before.status).toBe(200)
		expect(((await before.json()) as { next_step: unknown }).next_step).toBeNull()

		await post(agent.id, bet.id, { action: 'Go', due_at: inDays(1) })
		const after = await appAs(agent.id, 'agent').request(jsonGet(`/api/objects/${bet.id}`))
		expect(((await after.json()) as { next_step: { action: string } }).next_step.action).toBe('Go')
	})
})

describe('one query for driven objects that are late or have no step', () => {
	it('lists an overdue step and a missing step, and skips on-time, blocked and uncovered ones', async () => {
		const { agent, human, workspace } = await setup()
		const make = (over: Record<string, unknown>) =>
			insertObject(db, workspace.id, human, { driver: agent.id, ...over })

		const overdue = await make({ type: 'bet', status: 'active', title: 'overdue' })
		const missing = await make({ type: 'loop', status: 'live', title: 'missing' })
		const onTime = await make({ type: 'bet', status: 'active', title: 'on time' })
		const blocked = await make({ type: 'event', status: 'planned', title: 'blocked' })
		const task = await make({ type: 'task', status: 'in_progress', title: 'task' })
		const draftLoop = await make({ type: 'loop', status: 'draft', title: 'draft loop' })
		const humanDriven = await insertObject(db, workspace.id, human, {
			type: 'bet',
			status: 'active',
			driver: human,
		})

		const hourAgo = new Date(Date.now() - 3_600_000)
		const steps = [
			{ objectId: overdue.id, dueAt: hourAgo, status: 'open' },
			{ objectId: onTime.id, dueAt: new Date(Date.now() + 3_600_000), status: 'open' },
			{
				objectId: blocked.id,
				dueAt: hourAgo,
				status: 'blocked',
				blockedOnObjectId: task.id,
			},
		]
		await db.insert(nextSteps).values(
			steps.map((s) => ({
				workspaceId: workspace.id,
				action: 'x',
				ownerActorId: agent.id,
				...s,
			})),
		)

		const found = await findObjectsNeedingNextStep(db, { workspaceId: workspace.id })
		const byId = new Map(found.map((f) => [f.objectId, f.reason]))
		expect(byId.get(overdue.id)).toBe('overdue')
		expect(byId.get(missing.id)).toBe('missing')
		for (const skipped of [onTime, blocked, task, draftLoop, humanDriven]) {
			expect(byId.has(skipped.id)).toBe(false)
		}
	})
})
