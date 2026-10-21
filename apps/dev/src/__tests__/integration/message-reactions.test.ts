import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, messageReactions, messages, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string) {
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
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type Reaction = {
	emoji: string
	count: number
	reactedByMe: boolean
	actors: { actorId: string; actorName: string }[]
}

describe('Message reactions', () => {
	let ownerId: string
	let otherId: string
	let workspaceId: string
	let conversationId: string
	let messageId: number
	const ws = () => ({ 'x-workspace-id': workspaceId })
	const path = () => `/api/conversations/${conversationId}/messages/${messageId}/reactions`

	const react = (actor: string, emoji: string) =>
		appFor(actor).request(jsonRequest('PUT', path(), { emoji }, ws()))
	const unreact = (actor: string, emoji: string) =>
		appFor(actor).request(jsonDelete(`${path()}?emoji=${encodeURIComponent(emoji)}`, ws()))
	async function reactionsSeenBy(actor: string): Promise<Reaction[]> {
		const res = await appFor(actor).request(
			jsonGet(`/api/conversations/${conversationId}/messages`, ws()),
		)
		const { messages: page } = (await res.json()) as {
			messages: { id: number; reactions: Reaction[] }[]
		}
		return page.find((m) => m.id === messageId)?.reactions ?? []
	}

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		otherId = (await insertActor(db, { type: 'human' })).id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: otherId, role: 'member' })
		const created = await appFor(ownerId).request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Pipeline', participant_actor_ids: [otherId], initial_message: 'dry run done' },
				ws(),
			),
		)
		conversationId = ((await created.json()) as { id: string }).id
		const [m] = await db.select().from(messages).where(eq(messages.conversationId, conversationId))
		messageId = m?.id as number
	})

	it('groups reactions by emoji with counts, who, and whether the caller reacted', async () => {
		expect((await react(otherId, '👍')).status).toBe(204)
		expect((await react(ownerId, '👍')).status).toBe(204)
		expect((await react(ownerId, '✅')).status).toBe(204)
		const seen = await reactionsSeenBy(ownerId)
		expect(seen.map((r) => [r.emoji, r.count])).toEqual([
			['👍', 2],
			['✅', 1],
		])
		expect(seen.every((r) => r.reactedByMe)).toBe(true)
		const other = await reactionsSeenBy(otherId)
		expect(other.map((r) => r.reactedByMe)).toEqual([true, false])
		expect(seen[0]?.actors).toHaveLength(2)
	})

	it('is idempotent: repeating a reaction adds no row and no event', async () => {
		await react(ownerId, '👀')
		await react(ownerId, '👀')
		const rows = await db
			.select()
			.from(messageReactions)
			.where(eq(messageReactions.messageId, messageId))
		expect(rows).toHaveLength(1)
		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, conversationId), eq(events.action, 'message_updated')))
		expect(evs).toHaveLength(1)
	})

	it('removes only your own reaction, and removing a missing one is a no-op', async () => {
		await react(ownerId, '❤️')
		await react(otherId, '❤️')
		expect((await unreact(ownerId, '❤️')).status).toBe(204)
		expect((await unreact(ownerId, '❤️')).status).toBe(204)
		const seen = await reactionsSeenBy(ownerId)
		expect(seen).toHaveLength(1)
		expect(seen[0]?.count).toBe(1)
		expect(seen[0]?.reactedByMe).toBe(false)
	})

	it('accepts multi-codepoint emoji and rejects text', async () => {
		expect((await react(ownerId, '👍🏽')).status).toBe(204)
		expect((await react(ownerId, '🏳️‍🌈')).status).toBe(204)
		expect((await react(ownerId, 'hello')).status).toBe(400)
		expect((await react(ownerId, '')).status).toBe(400)
	})

	it('404s for a missing message and for someone outside the conversation', async () => {
		const outsider = await insertActor(db, { type: 'human' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: outsider.id, role: 'member' })
		expect((await react(outsider.id, '👍')).status).toBe(404)
		messageId = 999999999
		expect((await react(ownerId, '👍')).status).toBe(404)
	})

	it('drops reactions with their message', async () => {
		await react(ownerId, '👍')
		await db.delete(messages).where(eq(messages.id, messageId))
		const rows = await db
			.select()
			.from(messageReactions)
			.where(eq(messageReactions.messageId, messageId))
		expect(rows).toHaveLength(0)
	})
})
