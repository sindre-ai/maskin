import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: Record<string, unknown> }

const { default: actorsRoutes } = await import('../../routes/actors')
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
		c.set('db', db as Database)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {})
		c.set('sessionManager', { stopSession: async () => {}, createSession: async () => ({}) })
		c.set('agentStorage', { deleteAllAgentFiles: async () => {} })
		await next()
	})
	app.route('/api/actors', actorsRoutes as never)
	app.route('/api/events', eventsRoutes as never)
	return app
}

describe('An agent deleting another agent needs a person’s approval', () => {
	let workspaceId: string
	let humanId: string
	let askerId: string
	let targetId: string
	let objectId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		askerId = (await insertActor(db, { type: 'agent', name: 'Asker' })).id
		targetId = (await insertActor(db, { type: 'agent', name: 'Doomed' })).id
		await ensureWorkspaceMember(db, workspaceId, askerId)
		await ensureWorkspaceMember(db, workspaceId, targetId)
		objectId = (await insertObject(db, workspaceId, humanId, { type: 'task' })).id
	})

	const request = (
		as: string,
		type: string,
		method: string,
		path: string,
		body?: Record<string, unknown>,
		extra: Record<string, string> = {},
	) =>
		appAs(as, type).request(
			jsonRequest(method, path, body, { 'X-Workspace-Id': workspaceId, ...extra }),
		)

	const card = (actorId: string) => ({
		entity_id: objectId,
		content: 'Doomed has been idle for 30 days.',
		mentions: [humanId],
		decision: {
			title: 'Delete the Doomed agent?',
			summary: 'It has not run for 30 days and holds no open work.',
			options: [
				{
					label: 'Delete it',
					recommended: true,
					destructive: true,
					consequences: ['Its sessions and files go too', 'It cannot be undone'],
					delete_agent: { actor_id: actorId },
				},
				{ label: 'Keep it', consequences: ['Nothing changes', 'It keeps its slot'] },
			],
		},
	})

	const postCard = (actorId = targetId) =>
		request(askerId, 'agent', 'POST', '/api/events', card(actorId))

	const tap = (cardId: number, as = humanId, type = 'human', extra: Record<string, string> = {}) =>
		request(
			as,
			type,
			'POST',
			'/api/events',
			{ entity_id: objectId, content: 'Delete it', parent_event_id: cardId },
			extra,
		)

	const del = (as: string, id = targetId) => request(as, 'agent', 'DELETE', `/api/actors/${id}`)

	const exists = async (id: string) =>
		(await db.select({ id: actors.id }).from(actors).where(eq(actors.id, id))).length === 1

	const approvals = () =>
		db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, targetId),
					eq(events.action, 'deletion_approved'),
				),
			)

	it('refuses the delete with no approval and leaves the agent in place', async () => {
		const res = await del(askerId)

		expect(res.status).toBe(403)
		expect(await exists(targetId)).toBe(true)
	})

	it('records nothing on posting the card, and still refuses the delete', async () => {
		const res = await postCard()

		expect(res.status).toBe(201)
		expect(await approvals()).toHaveLength(0)
		expect((await del(askerId)).status).toBe(403)
		expect(await exists(targetId)).toBe(true)
	})

	it('deletes the agent after a person taps the option', async () => {
		const cardId = ((await (await postCard()).json()) as { id: number }).id

		expect((await tap(cardId)).status).toBe(201)
		const [approval] = await approvals()
		expect(approval?.actorId).toBe(humanId)
		expect((approval?.data as { requested_by: string }).requested_by).toBe(askerId)

		const res = await del(askerId)
		expect(res.status).toBe(200)
		expect(await exists(targetId)).toBe(false)
	})

	it('does not count a tap sent through MCP, where a model holds the person’s key', async () => {
		const cardId = ((await (await postCard()).json()) as { id: number }).id

		await tap(cardId, humanId, 'human', { 'X-Client-Source': 'mcp' })

		expect(await approvals()).toHaveLength(0)
		expect((await del(askerId)).status).toBe(403)
		expect(await exists(targetId)).toBe(true)
	})

	it('does not count a reply from an agent', async () => {
		const cardId = ((await (await postCard()).json()) as { id: number }).id

		await tap(cardId, askerId, 'agent')

		expect(await approvals()).toHaveLength(0)
		expect((await del(askerId)).status).toBe(403)
	})

	it('does not let a different agent use the approval', async () => {
		const otherId = (await insertActor(db, { type: 'agent', name: 'Bystander' })).id
		await ensureWorkspaceMember(db, workspaceId, otherId)
		const cardId = ((await (await postCard()).json()) as { id: number }).id
		await tap(cardId)

		expect((await del(otherId)).status).toBe(403)
		expect(await exists(targetId)).toBe(true)
	})

	it('does not let the approval cover a different agent', async () => {
		const bystanderId = (await insertActor(db, { type: 'agent', name: 'Bystander' })).id
		await ensureWorkspaceMember(db, workspaceId, bystanderId)
		const cardId = ((await (await postCard()).json()) as { id: number }).id
		await tap(cardId)

		expect((await del(askerId, bystanderId)).status).toBe(403)
		expect(await exists(bystanderId)).toBe(true)
	})

	it('lets the approval lapse after 24 hours', async () => {
		const cardId = ((await (await postCard()).json()) as { id: number }).id
		await tap(cardId)
		await db
			.update(events)
			.set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
			.where(and(eq(events.entityId, targetId), eq(events.action, 'deletion_approved')))

		expect((await del(askerId)).status).toBe(403)
		expect(await exists(targetId)).toBe(true)
	})

	it('rejects a card that names the author, a person, or an agent of another workspace', async () => {
		expect((await postCard(askerId)).status).toBe(400)
		expect((await postCard(humanId)).status).toBe(400)
		const outsiderId = (await insertActor(db, { type: 'agent', name: 'Outsider' })).id
		expect((await postCard(outsiderId)).status).toBe(400)
	})
})
