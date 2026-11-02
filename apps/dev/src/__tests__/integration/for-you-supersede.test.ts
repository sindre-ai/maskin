import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { forYouWithdrawals } from '@maskin/db/schema'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: forYouRoutes } = await import('../../routes/for-you')
const { default: eventsRoutes } = await import('../../routes/events')

function appAs(actorId: string, actorType: string) {
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
	app.use('/api/events/*', async (c, next) => {
		c.set('notifyBridge' as never, {} as never)
		c.set('sessionManager' as never, { createSession: async () => undefined } as never)
		await next()
	})
	app.route('/api/for-you', forYouRoutes)
	app.route('/api/events', eventsRoutes)
	return app
}

const decision = (title: string) => ({
	title,
	summary: 'Hans cancelled billing on 12 Oct and renewal is in 4 days.',
	ask: 'This goes to Hans in your name, so I will not send it alone.',
	options: [
		{
			label: 'Send as is',
			recommended: true,
			consequences: ['Reaches Hans today', 'Cannot be recalled'],
		},
		{ label: 'Skip', consequences: ['Nothing is sent', 'Renewal may lapse'] },
	],
})

describe('a new decision card replaces the same author’s older card on the same object', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (
			await insertActor(db, {
				type: 'agent',
				name: 'Writer',
				email: null,
				apiKey: `ank_writer_${Date.now()}_${Math.random()}`,
			})
		).id
	})

	async function postCard(
		as: { id: string; type: string },
		entityId: string,
		title: string,
		withDecision = true,
	) {
		const res = await appAs(as.id, as.type).request(
			jsonRequest(
				'POST',
				'/api/events',
				{
					entity_id: entityId,
					content: 'Approve the note to Hans.',
					mentions: [humanId],
					...(withDecision ? { decision: decision(title) } : {}),
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		return ((await res.json()) as { id: number }).id
	}

	async function headlines() {
		const res = await appAs(humanId, 'human').request(
			jsonGet('/api/for-you', { 'X-Workspace-Id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const { items } = (await res.json()) as { items: Array<{ headline: string }> }
		return items.map((i) => i.headline).sort()
	}

	const agent = () => ({ id: agentId, type: 'agent' })

	it('hides the first card when the same agent posts a second on the same object', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		const first = await postCard(agent(), obj.id, 'Is the older note ready?')
		expect(await headlines()).toEqual(['Is the older note ready?'])

		await postCard(agent(), obj.id, 'Is the newer note ready?')
		expect(await headlines()).toEqual(['Is the newer note ready?'])

		const rows = await db.select().from(forYouWithdrawals)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ sourceCommentId: first, withdrawnBy: agentId, workspaceId })
	})

	it('does not withdraw a card by another author on the same object', async () => {
		const other = await insertActor(db, {
			type: 'agent',
			name: 'Other writer',
			email: null,
			apiKey: `ank_other_${Date.now()}_${Math.random()}`,
		})
		const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		await postCard({ id: other.id, type: 'agent' }, obj.id, 'Is the other note ready?')
		const older = await postCard(agent(), obj.id, 'Is the older note ready?')
		await postCard(agent(), obj.id, 'Is the newer note ready?')
		// The list still shows only the newest card per object; what matters here is that
		// only this agent's earlier card was withdrawn, not the other author's.
		const rows = await db.select().from(forYouWithdrawals)
		expect(rows.map((r) => r.sourceCommentId)).toEqual([older])
		expect(await headlines()).toEqual(['Is the newer note ready?'])
	})

	it('keeps the same agent’s card on a different object', async () => {
		const one = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		const two = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		await postCard(agent(), one.id, 'Is note one ready?')
		await postCard(agent(), two.id, 'Is note two ready?')
		expect(await headlines()).toEqual(['Is note one ready?', 'Is note two ready?'])
	})

	it('does not retire a card when the new comment is plain text', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		await postCard(agent(), obj.id, 'Is the live note ready?')
		await postCard(agent(), obj.id, 'Plain comment only', false)
		expect(await headlines()).toEqual(['Is the live note ready?'])
		expect(await db.select().from(forYouWithdrawals)).toEqual([])
	})

	it('does not retire a person’s earlier card', async () => {
		const obj = await insertObject(db, workspaceId, humanId, { type: 'task', status: 'backlog' })
		const peer = await insertActor(db, {
			type: 'human',
			name: 'Peer',
			email: `peer_${Date.now()}_${Math.random()}@example.com`,
		})
		await postCard({ id: peer.id, type: 'human' }, obj.id, 'Is the peer note ready?')
		await postCard({ id: peer.id, type: 'human' }, obj.id, 'Is the second peer note ready?')
		expect(await db.select().from(forYouWithdrawals)).toEqual([])
	})
})
