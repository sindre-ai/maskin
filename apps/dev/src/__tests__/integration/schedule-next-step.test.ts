import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, nextSteps, objects, relationships, triggers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS } from '../../services/self-start-limits'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: nextStepRoutes } = await import('../../routes/object-next-step')

/**
 * schedule_next_step against real Postgres: the step and its wake-up are written together, the
 * wake-up is pinned to the object and step, closing or replacing the step cancels it, a run that
 * started on its own cannot leave more than a few waiting, and another agent gets a task instead
 * of a timer.
 */

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; maskinSessionId?: string }
}

function appAs(actorId: string, actorType = 'agent') {
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
		const session = c.req.header('X-Maskin-Session-Id')
		if (session) c.set('maskinSessionId', session)
		await next()
	})
	app.route('/api/objects', nextStepRoutes as never)
	return app
}

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
const tomorrow = () => inMinutes(24 * 60)

async function setup() {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent', name: 'Owner agent' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	const bet = await insertObject(db, workspace.id, human, {
		type: 'bet',
		status: 'active',
		driver: agent.id,
		title: 'Grow sign-ups',
	})
	return { human, workspace, agent, bet }
}

async function schedule(
	actorId: string,
	objectId: string,
	body: unknown,
	opts: { actorType?: string; sessionId?: string } = {},
) {
	return appAs(actorId, opts.actorType).request(
		jsonRequest(
			'POST',
			`/api/objects/${objectId}/schedule-next-step`,
			body,
			opts.sessionId ? { 'X-Maskin-Session-Id': opts.sessionId } : undefined,
		),
	)
}

async function closeStep(actorId: string, objectId: string, body: unknown) {
	return appAs(actorId).request(jsonRequest('PATCH', `/api/objects/${objectId}/next-step`, body))
}

const readTrigger = async (id: string) =>
	(await db.select().from(triggers).where(eq(triggers.id, id)))[0]

const readStep = async (id: string) =>
	(await db.select().from(nextSteps).where(eq(nextSteps.id, id)))[0]

describe('scheduling the next step for yourself', () => {
	it('stores the step and a one-off wake-up pinned to the object and step', async () => {
		const { agent, bet } = await setup()
		const due = tomorrow()
		const res = await schedule(agent.id, bet.id, {
			action: 'Read the sign-up numbers',
			due_at: due,
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			next_step: { id: string; status: string; owner_id: string }
			wake_up: { kind: string; trigger_id: string; at: string }
		}
		expect(body.next_step).toMatchObject({ status: 'open', owner_id: agent.id })
		expect(body.wake_up.kind).toBe('reminder')
		expect(new Date(body.wake_up.at).toISOString()).toBe(new Date(due).toISOString())

		const trigger = await readTrigger(body.wake_up.trigger_id)
		expect(trigger).toMatchObject({
			type: 'reminder',
			enabled: true,
			targetActorId: agent.id,
			createdBy: agent.id,
		})
		expect(trigger?.config).toEqual({
			scheduled_at: new Date(due).toISOString(),
			object_id: bet.id,
			step_id: body.next_step.id,
		})
		expect(trigger?.actionPrompt).toContain('Read the sign-up numbers')
		expect(trigger?.actionPrompt).toContain('more than 1 hour')
		expect((await readStep(body.next_step.id))?.wakeTriggerId).toBe(trigger?.id)
	})

	it('refuses a time less than five minutes away and writes nothing', async () => {
		const { agent, bet } = await setup()
		const res = await schedule(agent.id, bet.id, { action: 'Too soon', due_at: inMinutes(2) })
		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('5 minutes')
		expect(await db.select().from(nextSteps).where(eq(nextSteps.objectId, bet.id))).toHaveLength(0)
	})

	it('refuses a second step without replace, and replace cancels the first wake-up', async () => {
		const { agent, bet, workspace } = await setup()
		const first = (await (
			await schedule(agent.id, bet.id, { action: 'First check', due_at: tomorrow() })
		).json()) as { wake_up: { trigger_id: string } }

		const refused = await schedule(agent.id, bet.id, { action: 'Second', due_at: tomorrow() })
		expect(refused.status).toBe(409)
		expect(await readTrigger(first.wake_up.trigger_id)).toBeDefined()

		const replaced = await schedule(agent.id, bet.id, {
			action: 'Second check',
			due_at: tomorrow(),
			replace: true,
		})
		expect(replaced.status).toBe(201)
		const second = (await replaced.json()) as { wake_up: { trigger_id: string } }
		expect(await readTrigger(first.wake_up.trigger_id)).toBeUndefined()
		expect(await readTrigger(second.wake_up.trigger_id)).toBeDefined()

		const deletedEvents = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspace.id),
					eq(events.entityType, 'trigger'),
					eq(events.entityId, first.wake_up.trigger_id),
					eq(events.action, 'deleted'),
				),
			)
		expect(deletedEvents).toHaveLength(1)
	})

	it('closing the step early cancels the wake-up', async () => {
		const { agent, bet } = await setup()
		const made = (await (
			await schedule(agent.id, bet.id, { action: 'Check later', due_at: tomorrow() })
		).json()) as { wake_up: { trigger_id: string }; next_step: { id: string } }

		const closed = await closeStep(agent.id, bet.id, {
			status: 'done',
			evidence: 'Done early, numbers are in the doc',
		})
		expect(closed.status).toBe(200)
		expect(await readTrigger(made.wake_up.trigger_id)).toBeUndefined()
		expect((await readStep(made.next_step.id))?.wakeTriggerId).toBeNull()
	})

	it('moving the due time moves the wake-up', async () => {
		const { agent, bet } = await setup()
		const made = (await (
			await schedule(agent.id, bet.id, { action: 'Check later', due_at: tomorrow() })
		).json()) as { wake_up: { trigger_id: string } }

		const later = inMinutes(3 * 24 * 60)
		const res = await closeStep(agent.id, bet.id, { due_at: later })
		expect(res.status).toBe(200)
		const trigger = await readTrigger(made.wake_up.trigger_id)
		expect((trigger?.config as { scheduled_at: string }).scheduled_at).toBe(
			new Date(later).toISOString(),
		)
		expect(trigger?.enabled).toBe(true)
	})
})

describe('editing a step that has a wake-up', () => {
	it('refuses a new owner and leaves the wake-up and step alone', async () => {
		const { agent, bet, workspace } = await setup()
		const other = await insertActor(db, { type: 'agent', name: 'Other agent' })
		await ensureWorkspaceMember(db, workspace.id, other.id)
		const made = (await (
			await schedule(agent.id, bet.id, { action: 'Check later', due_at: tomorrow() })
		).json()) as { wake_up: { trigger_id: string }; next_step: { id: string } }

		const res = await closeStep(agent.id, bet.id, { owner_id: other.id })
		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('schedule_next_step')
		expect((await readStep(made.next_step.id))?.ownerActorId).toBe(agent.id)
		expect((await readTrigger(made.wake_up.trigger_id))?.targetActorId).toBe(agent.id)
	})

	it('allows naming the current owner again', async () => {
		const { agent, bet } = await setup()
		await schedule(agent.id, bet.id, { action: 'Check later', due_at: tomorrow() })
		const res = await closeStep(agent.id, bet.id, { owner_id: agent.id })
		expect(res.status).toBe(200)
	})

	it('rewrites the wake-up prompt when the action changes', async () => {
		const { agent, bet } = await setup()
		const made = (await (
			await schedule(agent.id, bet.id, { action: 'Read the numbers', due_at: tomorrow() })
		).json()) as { wake_up: { trigger_id: string } }
		const before = await readTrigger(made.wake_up.trigger_id)

		const res = await closeStep(agent.id, bet.id, { action: 'Write the summary' })
		expect(res.status).toBe(200)
		const after = await readTrigger(made.wake_up.trigger_id)
		expect(after?.actionPrompt).toContain('Write the summary')
		expect(after?.actionPrompt).not.toContain('Read the numbers')
		expect(after?.name).toContain('Write the summary')
		expect(after?.config).toEqual(before?.config)
	})
})

describe('the cap on wake-ups left by runs that started on their own', () => {
	it('allows a few, then refuses the next one with a clear message', async () => {
		const { human, agent, workspace } = await setup()
		const run = await insertSession(db, workspace.id, agent.id, human, {
			status: 'running',
			config: { start_reason: 'self_wakeup' },
		})
		for (let i = 0; i < MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS; i++) {
			const bet = await insertObject(db, workspace.id, human, { type: 'bet', status: 'active' })
			const res = await schedule(
				agent.id,
				bet.id,
				{ action: `Check ${i}`, due_at: tomorrow() },
				{ sessionId: run.id },
			)
			expect(res.status).toBe(201)
		}
		const over = await insertObject(db, workspace.id, human, { type: 'bet', status: 'active' })
		const refused = await schedule(
			agent.id,
			over.id,
			{ action: 'One too many', due_at: tomorrow() },
			{ sessionId: run.id },
		)
		expect(refused.status).toBe(429)
		expect(await refused.text()).toContain('scheduled triggers waiting')
		expect(await db.select().from(nextSteps).where(eq(nextSteps.objectId, over.id))).toHaveLength(0)
	})

	it('does not limit a run a person started', async () => {
		const { human, agent, workspace } = await setup()
		const run = await insertSession(db, workspace.id, agent.id, human, {
			status: 'running',
			config: { start_reason: 'person' },
		})
		for (let i = 0; i < MAX_PENDING_TRIGGERS_FROM_SELF_STARTED_RUNS + 1; i++) {
			const bet = await insertObject(db, workspace.id, human, { type: 'bet', status: 'active' })
			const res = await schedule(
				agent.id,
				bet.id,
				{ action: `Check ${i}`, due_at: tomorrow() },
				{ sessionId: run.id },
			)
			expect(res.status).toBe(201)
		}
	})
})

describe('scheduling the next step for someone else', () => {
	it('gives another agent a task and blocks the step on it, with no timer', async () => {
		const { agent, bet, workspace } = await setup()
		const other = await insertActor(db, { type: 'agent', name: 'Researcher' })
		await ensureWorkspaceMember(db, workspace.id, other.id)

		const res = await schedule(agent.id, bet.id, {
			action: 'Find ten leads in logistics',
			due_at: tomorrow(),
			owner_id: other.id,
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			next_step: { status: string; owner_id: string; blocked_on_object_id: string }
			wake_up: { kind: string; task_id: string }
		}
		expect(body.wake_up.kind).toBe('task')
		expect(body.next_step).toMatchObject({
			status: 'blocked',
			owner_id: other.id,
			blocked_on_object_id: body.wake_up.task_id,
		})

		const [task] = await db.select().from(objects).where(eq(objects.id, body.wake_up.task_id))
		expect(task).toMatchObject({
			type: 'task',
			status: 'todo',
			driver: other.id,
			title: 'Find ten leads in logistics',
		})
		const [edge] = await db
			.select()
			.from(relationships)
			.where(eq(relationships.targetId, task?.id as string))
		expect(edge).toMatchObject({ sourceId: bet.id, type: 'breaks_into' })

		// The move to todo is a real status change: that is what wakes the task's driver.
		const statusChanges = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, task?.id as string), eq(events.action, 'status_changed')))
		expect(statusChanges).toHaveLength(1)

		expect(
			await db.select().from(triggers).where(eq(triggers.workspaceId, workspace.id)),
		).toHaveLength(0)
	})

	it('stores the step for a person and wakes nobody', async () => {
		const { human, agent, bet, workspace } = await setup()
		const res = await schedule(agent.id, bet.id, {
			action: 'Approve the launch copy',
			due_at: tomorrow(),
			owner_id: human,
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			next_step: { owner_id: string; status: string }
			wake_up: { kind: string }
		}
		expect(body.wake_up.kind).toBe('none')
		expect(body.next_step).toMatchObject({ owner_id: human, status: 'open' })
		expect(
			await db.select().from(triggers).where(eq(triggers.workspaceId, workspace.id)),
		).toHaveLength(0)
	})
})
