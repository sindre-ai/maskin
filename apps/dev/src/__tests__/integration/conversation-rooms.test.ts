import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
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
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type RoomKind = 'free' | 'flow' | null
interface Chat {
	id: string
	roomKind: RoomKind
	directPairKey?: string | null
	subjectId?: string | null
}

describe('rooms', () => {
	let personId: string
	let workspaceId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })
	const api = () => appFor(personId)
	const post = (body: Record<string, unknown>) =>
		api().request(jsonRequest('POST', '/api/conversations', body, ws()))
	const patch = (id: string, body: Record<string, unknown>) =>
		api().request(jsonRequest('PATCH', `/api/conversations/${id}`, body, ws()))
	const get = async (id: string) =>
		(await (await api().request(jsonGet(`/api/conversations/${id}`, ws()))).json()) as Chat
	const listed = async (query = '') =>
		(
			(await (
				await api().request(jsonGet(`/api/conversations?limit=100${query}`, ws()))
			).json()) as { conversations: Chat[] }
		).conversations

	beforeEach(async () => {
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
	})

	it('starts every chat as not a room', async () => {
		const res = await post({ title: 'Plain', participant_actor_ids: [] })
		expect(res.status).toBe(201)
		const chat = (await res.json()) as Chat
		expect(chat.roomKind).toBeNull()
		const [row] = await db.select().from(conversations).where(eq(conversations.id, chat.id))
		expect(row?.isRoom).toBe(false)
	})

	it('creates a room and lists it as one', async () => {
		const res = await post({ title: 'W46', participant_actor_ids: [], room: true })
		expect(res.status).toBe(201)
		const room = (await res.json()) as Chat
		expect(room.roomKind).toBe('free')
		expect((await listed()).find((c) => c.id === room.id)?.roomKind).toBe('free')
	})

	it('refuses a room that is also a direct message or about a subject', async () => {
		const flow = await insertObject(db, workspaceId, personId, { type: 'loop', status: 'paused' })
		const res = await post({
			title: 'Both',
			participant_actor_ids: [],
			room: true,
			subject: { type: 'object', id: flow?.id },
		})
		expect(res.status).toBe(400)
	})

	it('makes a chat a room and turns it back into a chat', async () => {
		const chat = (await (await post({ title: 'Topic', participant_actor_ids: [] })).json()) as Chat

		const made = await patch(chat.id, { room: true })
		expect(made.status).toBe(200)
		expect(((await made.json()) as Chat).roomKind).toBe('free')
		expect((await get(chat.id)).roomKind).toBe('free')

		const back = await patch(chat.id, { room: false })
		expect(((await back.json()) as Chat).roomKind).toBeNull()
		expect((await get(chat.id)).roomKind).toBeNull()
	})

	it('keeps rooms in the always-listed priority scope and out of the recent scope', async () => {
		const room = (await (
			await post({ title: 'Room', participant_actor_ids: [], room: true })
		).json()) as Chat
		const plain = (await (await post({ title: 'Plain', participant_actor_ids: [] })).json()) as Chat

		const priority = (await listed('&scope=priority')).map((c) => c.id)
		const recent = (await listed('&scope=recent')).map((c) => c.id)
		expect(priority).toContain(room.id)
		expect(priority).not.toContain(plain.id)
		expect(recent).not.toContain(room.id)
		expect(recent).toContain(plain.id)
	})

	it('makes a room about a flow, which keeps the room flag', async () => {
		const room = (await (
			await post({ title: 'Weekly', participant_actor_ids: [], room: true })
		).json()) as Chat
		const flow = await insertObject(db, workspaceId, personId, { type: 'loop', status: 'paused' })

		const res = await patch(room.id, { subject: { type: 'object', id: flow?.id } })
		expect(res.status).toBe(200)
		const updated = (await res.json()) as Chat
		expect(updated.roomKind).toBe('flow')
		expect(updated.subjectId).toBe(flow?.id)

		// Turning the room flag off leaves a flow's chat a flow room: the flow is what makes it one.
		const off = await patch(room.id, { room: false })
		expect(((await off.json()) as Chat).roomKind).toBe('flow')
		expect((await listed('&scope=priority')).find((c) => c.id === room.id)?.roomKind).toBe('flow')
	})

	it('lists the chat about a flow as a flow room without the room flag', async () => {
		const flow = await insertObject(db, workspaceId, personId, { type: 'loop', status: 'paused' })
		const res = await post({
			title: 'Flow chat',
			participant_actor_ids: [],
			subject: { type: 'object', id: flow?.id },
		})
		expect(((await res.json()) as Chat).roomKind).toBe('flow')
	})

	it('does not call the chat about an ordinary object a room', async () => {
		const task = await insertObject(db, workspaceId, personId, { type: 'task', status: 'todo' })
		const res = await post({
			title: 'Task chat',
			participant_actor_ids: [],
			subject: { type: 'object', id: task?.id },
		})
		expect(((await res.json()) as Chat).roomKind).toBeNull()
	})

	it('refuses a second subject, a missing subject and a second chat for one flow', async () => {
		const flow = await insertObject(db, workspaceId, personId, { type: 'loop', status: 'paused' })
		const other = await insertObject(db, workspaceId, personId, { type: 'loop', status: 'paused' })
		const first = (await (
			await post({ title: 'First', participant_actor_ids: [], room: true })
		).json()) as Chat
		const second = (await (
			await post({ title: 'Second', participant_actor_ids: [], room: true })
		).json()) as Chat

		expect(
			(await patch(first.id, { subject: { type: 'object', id: crypto.randomUUID() } })).status,
		).toBe(400)
		expect((await patch(first.id, { subject: { type: 'object', id: flow?.id } })).status).toBe(200)
		// A chat has one subject, and a flow has one chat.
		expect((await patch(first.id, { subject: { type: 'object', id: other?.id } })).status).toBe(400)
		expect((await patch(second.id, { subject: { type: 'object', id: flow?.id } })).status).toBe(409)
	})

	it('never makes a direct message a room', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
		const dm = (await (
			await post({ title: 'Agent', participant_actor_ids: [agent.id], direct: true })
		).json()) as Chat
		expect((await patch(dm.id, { room: true })).status).toBe(400)
		expect((await get(dm.id)).roomKind).toBeNull()
	})
})
