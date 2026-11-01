import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { desc, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: forYouRoutes } = await import('../../routes/for-you')
const { default: eventsRoutes } = await import('../../routes/events')

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
		c.set('notifyBridge' as never, {} as never)
		c.set('sessionManager' as never, { createSession: async () => undefined } as never)
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	app.route('/api/events', eventsRoutes)
	return app
}

describe('decision cards with a status button', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (
			await insertActor(db, {
				type: 'agent',
				name: 'Strategist',
				email: null,
				apiKey: `ank_strat_${Date.now()}_${Math.random()}`,
			})
		).id
	})

	const FLIP = {
		title: 'Flip the onboarding bet to active?',
		summary: 'The bet has sat in proposed for 9 days. The plan and 4 tasks are ready.',
		ask: 'Starting the work spends the team week, so I will not flip it alone.',
		options: [
			{ label: 'Go', recommended: true, consequences: ['Work starts today', 'Uses the team week'] },
			{ label: 'Hold', consequences: ['Nothing starts', 'The bet keeps waiting'] },
		],
	}
	const withAction = (target?: string) => ({
		...FLIP,
		options: [
			{
				...FLIP.options[0],
				set_status: { status: 'active', ...(target ? { object_id: target } : {}) },
			},
			FLIP.options[1],
		],
	})

	const bet = (status = 'proposed') =>
		insertObject(db, workspaceId, humanId, { type: 'bet', status })

	function postAs(actorId: string, actorType: string, body: Record<string, unknown>) {
		return appAs(actorId, actorType).request(
			jsonRequest('POST', '/api/events', body, { 'X-Workspace-Id': workspaceId }),
		)
	}
	const agentCard = (entityId: string, decision: Record<string, unknown>) =>
		postAs(agentId, 'agent', {
			entity_id: entityId,
			content: 'Ready to start.',
			mentions: [humanId],
			decision,
		})
	const tap = (entityId: string, cardId: number, content = 'Go', as = humanId, type = 'human') =>
		postAs(as, type, { entity_id: entityId, content, parent_event_id: cardId })

	async function list() {
		const res = await appAs(humanId).request(
			jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
		)
		const body = (await res.json()) as { data: { items: Array<{ entity_id: string }> } }
		return body.data.items
	}
	const statusOf = async (id: string) =>
		(await db.select({ s: objects.status }).from(objects).where(eq(objects.id, id)))[0]?.s

	async function cardOn(entityId: string, decision: Record<string, unknown>) {
		const res = await agentCard(entityId, decision)
		expect(res.status).toBe(201)
		return ((await res.json()) as { data: { id: number } }).data.id
	}

	describe('posting a card', () => {
		it('rejects a card that asks to flip a status without a button, with a snippet to copy', async () => {
			const b = await bet()
			const res = await agentCard(b.id, FLIP)
			expect(res.status).toBe(400)
			const text = JSON.stringify(await res.json())
			expect(text).toContain('set_status')
			expect(text).toContain('active')
		})

		it('accepts the same card with no_status_action set (a false match)', async () => {
			const b = await bet()
			expect((await agentCard(b.id, { ...FLIP, no_status_action: true })).status).toBe(201)
		})

		it('leaves a card about something else alone', async () => {
			const b = await bet()
			const other = {
				...FLIP,
				title: 'Park the launch email?',
				options: [
					{
						label: 'Send it',
						recommended: true,
						consequences: ['Goes out today', 'Cannot be recalled'],
					},
					{ label: 'Hold', consequences: ['Nothing goes out', 'The launch slips'] },
				],
			}
			expect((await agentCard(b.id, other)).status).toBe(201)
		})

		it('leaves a card that carries a draft alone even if the title names a status', async () => {
			const b = await bet()
			const draft = await insertObject(db, workspaceId, humanId, { type: 'task', content: 'Hej' })
			const res = await agentCard(b.id, { ...FLIP, draft: { object_id: draft.id } })
			expect(res.status).toBe(201)
		})

		it('rejects a status the object type does not have, and a bet already in that status', async () => {
			const b = await bet()
			const bad = withAction()
			bad.options[0] = { ...bad.options[0], set_status: { status: 'nonsense' } } as never
			expect((await agentCard(b.id, bad)).status).toBe(400)
			const active = await bet('active')
			expect((await agentCard(active.id, withAction())).status).toBe(400)
		})

		it('replaces a stamp the agent sent with the real status', async () => {
			const b = await bet()
			const id = await cardOn(b.id, {
				...withAction(),
				status_stamp: { object_id: b.id, status: 'active' },
			})
			const [row] = await db.select().from(events).where(eq(events.id, id))
			const stamp = (row?.data as { decision: { status_stamp: unknown } }).decision.status_stamp
			expect(stamp).toEqual({ object_id: b.id, status: 'proposed' })
		})
	})

	describe('what drops the card', () => {
		it('keeps it while the object is in the stamped status', async () => {
			const b = await bet()
			await cardOn(b.id, withAction())
			expect((await list()).map((i) => i.entity_id)).toEqual([b.id])
		})

		it('drops it once the object has moved to any other status', async () => {
			const b = await bet()
			await cardOn(b.id, withAction())
			await db.update(objects).set({ status: 'paused' }).where(eq(objects.id, b.id))
			expect(await list()).toEqual([])
		})

		it('keeps a card without a status button when the object moves on', async () => {
			const b = await bet()
			await cardOn(b.id, { ...FLIP, title: 'Ship the flag at 10%?', no_status_action: true })
			await db.update(objects).set({ status: 'active' }).where(eq(objects.id, b.id))
			expect(await list()).toHaveLength(1)
		})

		it('follows the target object when the card sits on another object', async () => {
			const loop = await insertObject(db, workspaceId, humanId, { type: 'loop', status: 'running' })
			const b = await bet()
			await cardOn(loop.id, withAction(b.id))
			expect(await list()).toHaveLength(1)
			await db.update(objects).set({ status: 'active' }).where(eq(objects.id, b.id))
			expect(await list()).toEqual([])
		})
	})

	describe('tapping the button', () => {
		it('changes the status as the person, records the change and retires the card', async () => {
			const b = await bet()
			const cardId = await cardOn(b.id, withAction())
			const res = await tap(b.id, cardId)
			expect(res.status).toBe(201)
			const body = (await res.json()) as { data: { status_action?: { applied: boolean } } }
			expect(body.data.status_action?.applied).toBe(true)
			expect(await statusOf(b.id)).toBe('active')
			const [change] = await db
				.select()
				.from(events)
				.where(eq(events.entityId, b.id))
				.orderBy(desc(events.id))
				.limit(5)
				.then((rows) => rows.filter((r) => r.action === 'status_changed'))
			expect(change?.actorId).toBe(humanId)
			expect(await list()).toEqual([])
		})

		it('moves the target object when the card sits on another object', async () => {
			const loop = await insertObject(db, workspaceId, humanId, { type: 'loop', status: 'running' })
			const b = await bet()
			const cardId = await cardOn(loop.id, withAction(b.id))
			expect((await tap(loop.id, cardId)).status).toBe(201)
			expect(await statusOf(b.id)).toBe('active')
			expect(await statusOf(loop.id)).toBe('running')
		})

		it('does nothing and says so when the object has moved on since the card', async () => {
			const b = await bet()
			const cardId = await cardOn(b.id, withAction())
			await db.update(objects).set({ status: 'paused' }).where(eq(objects.id, b.id))
			const res = await tap(b.id, cardId)
			expect(res.status).toBe(201)
			const body = (await res.json()) as {
				data: { status_action?: { applied: boolean; reason?: string; current_status?: string } }
			}
			expect(body.data.status_action).toMatchObject({
				applied: false,
				reason: 'moved_on',
				current_status: 'paused',
			})
			expect(await statusOf(b.id)).toBe('paused')
		})

		it('leaves the status alone for the other option and for an agent replying', async () => {
			const b = await bet()
			const cardId = await cardOn(b.id, withAction())
			expect((await tap(b.id, cardId, 'Hold')).status).toBe(201)
			expect(await statusOf(b.id)).toBe('proposed')
			expect((await tap(b.id, cardId, 'Go', agentId, 'agent')).status).toBe(201)
			expect(await statusOf(b.id)).toBe('proposed')
		})
	})
})
