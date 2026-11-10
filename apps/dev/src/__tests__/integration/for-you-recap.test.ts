import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: forYouRoutes } = await import('../../routes/for-you')

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
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	return app
}

type Recap = {
	since: string
	asks_answered: { count: number; items: Array<{ object_id: string; comment_id: number }> }
	items_moved: { count: number; items: Array<{ object_id: string; status: string }> }
	agents_finished: { count: number; items: Array<{ agent_id: string; sessions: number }> }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('GET /api/for-you/recap', () => {
	let workspaceId: string
	let me: string
	let colleague: string
	let agentId: string
	let now: number

	beforeEach(async () => {
		me = getTestActorId()
		workspaceId = (await insertWorkspace(db, me)).id
		colleague = (await insertActor(db, { type: 'human' })).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Writer' })).id
		now = Date.now()
	})

	const ago = (ms: number) => new Date(now - ms)

	async function event(over: {
		workspaceId?: string
		actorId: string
		action: string
		entityType: string
		entityId: string
		data?: unknown
		at: Date
	}) {
		const [row] = await db
			.insert(events)
			.values({
				workspaceId: over.workspaceId ?? workspaceId,
				actorId: over.actorId,
				action: over.action,
				entityType: over.entityType,
				entityId: over.entityId,
				data: over.data ?? {},
				createdAt: over.at,
			})
			.returning()
		return row.id
	}

	async function recap(since: Date): Promise<Recap> {
		const res = await appAs(me).request(
			jsonGet(`/api/for-you/recap?since=${encodeURIComponent(since.toISOString())}`, {
				'X-Workspace-Id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		return (await res.json()) as Recap
	}

	it('is empty for a person with nothing new', async () => {
		const body = await recap(ago(HOUR))
		expect(body.asks_answered).toEqual({ count: 0, items: [] })
		expect(body.items_moved).toEqual({ count: 0, items: [] })
		expect(body.agents_finished).toEqual({ count: 0, items: [] })
	})

	it('counts items others moved after the cutoff, once each, and leaves the rest out', async () => {
		const moved = await insertObject(db, workspaceId, me, { type: 'task', status: 'done' })
		const old = await insertObject(db, workspaceId, me, { type: 'task', status: 'done' })
		const mine = await insertObject(db, workspaceId, me, { type: 'task', status: 'done' })
		const note = await insertObject(db, workspaceId, me, { type: 'knowledge', status: 'done' })
		// Object events are logged under the object's own type (task, bet, insight ...).
		const move = (entityId: string, actorId: string, at: Date, entityType = 'task') =>
			event({ actorId, action: 'status_changed', entityType, entityId, at })

		await move(moved.id, agentId, ago(3 * HOUR))
		await move(moved.id, colleague, ago(2 * HOUR))
		await move(old.id, agentId, ago(10 * HOUR))
		await move(mine.id, me, ago(HOUR))
		// Only insights, bets and tasks are part of the recap.
		await move(note.id, agentId, ago(HOUR), 'knowledge')

		const body = await recap(ago(6 * HOUR))
		expect(body.items_moved.count).toBe(1)
		expect(body.items_moved.items).toEqual([
			expect.objectContaining({ object_id: moved.id, status: 'done' }),
		])
	})

	it('counts agents with a completed session, with how many each', async () => {
		const session = (actorId: string, action: string, at: Date) =>
			event({ actorId, action, entityType: 'session', entityId: crypto.randomUUID(), at })
		const other = (await insertActor(db, { type: 'agent', name: 'Reviewer' })).id

		await session(agentId, 'session_completed', ago(2 * HOUR))
		await session(agentId, 'session_completed', ago(HOUR))
		await session(other, 'session_failed', ago(HOUR))
		await session(other, 'session_completed', ago(12 * HOUR))

		const body = await recap(ago(6 * HOUR))
		expect(body.agents_finished.count).toBe(1)
		expect(body.agents_finished.items).toEqual([
			expect.objectContaining({ agent_id: agentId, sessions: 2 }),
		])
	})

	it('counts a decision card addressed to me that a colleague replied to', async () => {
		const obj = await insertObject(db, workspaceId, me, { type: 'bet', status: 'active' })
		const card = (mentions: string[], at: Date) =>
			event({
				actorId: agentId,
				action: 'commented',
				entityType: 'object',
				entityId: obj.id,
				data: {
					content: 'Ship it?',
					mentions,
					decision: { title: 'Ship it?', summary: 'Ready.', options: [] },
				},
				at,
			})
		const reply = (actorId: string, parent: number, at: Date) =>
			event({
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId: obj.id,
				data: { content: 'Go', parentEventId: parent },
				at,
			})

		const answered = await card([me], ago(5 * HOUR))
		await reply(colleague, answered, ago(2 * HOUR))
		// A second reply to the same card is still one answered ask.
		await reply(colleague, answered, ago(HOUR))
		// My own reply, an agent's reply and a card meant for someone else do not count.
		const mine = await card([me], ago(5 * HOUR))
		await reply(me, mine, ago(HOUR))
		const byAgent = await card([me], ago(5 * HOUR))
		await reply(agentId, byAgent, ago(HOUR))
		const forColleague = await card([colleague], ago(5 * HOUR))
		await reply(colleague, forColleague, ago(HOUR))
		// A reply from before the cutoff was already seen.
		const early = await card([me], ago(20 * HOUR))
		await reply(colleague, early, ago(10 * HOUR))

		const body = await recap(ago(6 * HOUR))
		expect(body.asks_answered.count).toBe(1)
		expect(body.asks_answered.items).toEqual([
			expect.objectContaining({ object_id: obj.id, comment_id: answered }),
		])
	})

	it('never reads another workspace', async () => {
		const elsewhere = (await insertWorkspace(db, colleague)).id
		const foreign = await insertObject(db, elsewhere, colleague, { type: 'task', status: 'done' })
		await event({
			workspaceId: elsewhere,
			actorId: agentId,
			action: 'status_changed',
			entityType: 'task',
			entityId: foreign.id,
			at: ago(HOUR),
		})
		await event({
			workspaceId: elsewhere,
			actorId: agentId,
			action: 'session_completed',
			entityType: 'session',
			entityId: crypto.randomUUID(),
			at: ago(HOUR),
		})

		const body = await recap(ago(6 * HOUR))
		expect(body.items_moved.count).toBe(0)
		expect(body.agents_finished.count).toBe(0)
	})

	it('cuts a since time older than 7 days to 7 days', async () => {
		const stale = await insertObject(db, workspaceId, me, { type: 'task', status: 'done' })
		await event({
			actorId: agentId,
			action: 'status_changed',
			entityType: 'task',
			entityId: stale.id,
			at: ago(9 * DAY),
		})

		const body = await recap(ago(30 * DAY))
		expect(body.items_moved.count).toBe(0)
		expect(Date.parse(body.since)).toBeGreaterThan(now - 8 * DAY)
	})

	it('refuses a missing or malformed since time', async () => {
		const res = await appAs(me).request(
			jsonGet('/api/for-you/recap?since=yesterday', { 'X-Workspace-Id': workspaceId }),
		)
		expect(res.status).toBe(400)
	})
})
