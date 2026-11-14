import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import * as schema from '@maskin/db/schema'
import { conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createApiError, formatZodError } from '../../lib/errors'
import { loadReactionsByMessage } from '../../services/message-reactions'
import { loadThreadSummaries } from '../../services/message-threads'
import {
	loadPendingSpawnedSessions,
	loadSpawnedSessionsByMessage,
} from '../../services/spawned-sessions'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function createApp(actorId: string, appDb: Database = db) {
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
		c.set('db', appDb)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

describe('GET /api/conversations/unread-count', () => {
	let workspaceId: string
	let humanId: string
	let otherId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id
		const other = await insertActor(db, { type: 'human' })
		if (!other) throw new Error('failed to seed actor')
		otherId = other.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: otherId, role: 'member' })
	})

	async function seedChat(
		title: string,
		opts: {
			inWorkspace?: string
			participant?: Partial<typeof conversationParticipants.$inferInsert>
			fromOther?: number
			fromSelf?: number
		} = {},
	) {
		const conversation = await insertConversation(db, opts.inWorkspace ?? workspaceId, humanId, {
			title,
		})
		if (!conversation) throw new Error('failed to seed conversation')
		await db.insert(conversationParticipants).values([
			{ conversationId: conversation.id, actorId: humanId, ...opts.participant },
			{ conversationId: conversation.id, actorId: otherId },
		])
		for (let i = 0; i < (opts.fromOther ?? 0); i++) {
			await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: otherId, content: `o${i}` })
		}
		for (let i = 0; i < (opts.fromSelf ?? 0); i++) {
			await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: humanId, content: `s${i}` })
		}
		return conversation
	}

	async function count(actorId = humanId) {
		const res = await createApp(actorId).request(
			jsonGet('/api/conversations/unread-count', { 'x-workspace-id': workspaceId }),
		)
		return { status: res.status, body: (await res.json()) as { count: number } }
	}

	async function listUnreadOnly(actorId = humanId) {
		const res = await createApp(actorId).request(
			jsonGet('/api/conversations?unread_only=true&limit=100', { 'x-workspace-id': workspaceId }),
		)
		return (await res.json()) as { conversations: { id: string }[] }
	}

	it('equals the list unread_only count for the same fixture, across every exclusion', async () => {
		await seedChat('unread-a', { fromOther: 2 })
		await seedChat('unread-b', { fromOther: 1 })
		await seedChat('only my own messages', { fromSelf: 3 })
		await seedChat('empty')
		await seedChat('archived', { fromOther: 1, participant: { archived: true } })
		await seedChat('left', { fromOther: 1, participant: { leftAt: new Date() } })
		const read = await seedChat('read', { fromOther: 2 })
		const readMessages = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, read.id))
			.orderBy(asc(messages.id))
		await db
			.update(conversationParticipants)
			.set({ lastReadMessageId: readMessages[readMessages.length - 1]?.id ?? 0 })
			.where(
				and(
					eq(conversationParticipants.conversationId, read.id),
					eq(conversationParticipants.actorId, humanId),
				),
			)
		const otherWs = await insertWorkspace(db, humanId)
		if (!otherWs) throw new Error('failed to seed workspace')
		await seedChat('other workspace', { inWorkspace: otherWs.id, fromOther: 1 })

		const list = await listUnreadOnly()
		const result = await count()
		expect(result.status).toBe(200)
		expect(list.conversations).toHaveLength(2)
		expect(result.body.count).toBe(list.conversations.length)
	})

	it('is not capped by the list page size', async () => {
		for (let i = 0; i < 33; i++) await seedChat(`c${i}`, { fromOther: 1 })
		expect((await count()).body.count).toBe(33)
	})

	it('returns 0 for an actor who is in no chats', async () => {
		await seedChat('mine', { fromOther: 1 })
		const stranger = await insertActor(db, { type: 'human' })
		if (!stranger) throw new Error('failed to seed actor')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: stranger.id, role: 'member' })
		expect((await count(stranger.id)).body).toEqual({ count: 0 })
	})

	it('rejects a request without a workspace header', async () => {
		const res = await createApp(humanId).request(jsonGet('/api/conversations/unread-count'))
		expect(res.status).toBe(400)
	})
})

describe('GET /api/conversations/:id/messages query plan', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		if (!agent) throw new Error('failed to seed agent')
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
	})

	async function seed() {
		const conversation = await insertConversation(db, workspaceId, humanId, { title: 'plan' })
		if (!conversation) throw new Error('failed to seed conversation')
		await db.insert(conversationParticipants).values([
			{ conversationId: conversation.id, actorId: humanId },
			{ conversationId: conversation.id, actorId: agentId },
		])
		const [root] = await db
			.insert(messages)
			.values({ conversationId: conversation.id, actorId: agentId, content: 'root' })
			.returning()
		if (!root) throw new Error('failed to seed message')
		await db.insert(messages).values({
			conversationId: conversation.id,
			actorId: humanId,
			content: 'reply',
			threadRootId: root.id,
		})
		const spawner = await insertSession(db, workspaceId, agentId, humanId, {
			conversationId: conversation.id,
			status: 'running',
			interactive: true,
		})
		await insertSession(db, workspaceId, agentId, humanId, {
			status: 'running',
			spawnedBySessionId: spawner.id,
			spawnedByMessageId: root.id,
		})
		await insertSession(db, workspaceId, agentId, humanId, {
			status: 'running',
			spawnedBySessionId: spawner.id,
		})
		return { conversation, root }
	}

	it('answers exactly what the sequential, re-checking loaders produce', async () => {
		const { conversation, root } = await seed()
		const res = await createApp(humanId).request(
			jsonGet(`/api/conversations/${conversation.id}/messages`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			messages: { id: number; spawned_sessions: unknown[]; thread: unknown }[]
			pending_handoffs?: unknown[]
		}

		// Reference: the same loaders one after another, each doing its own participant check.
		const ids = body.messages.map((m) => m.id)
		const spawned = await loadSpawnedSessionsByMessage(db, {
			conversationId: conversation.id,
			workspaceId,
			messageIds: ids,
			actorId: humanId,
		})
		const pending = await loadPendingSpawnedSessions(db, {
			conversationId: conversation.id,
			workspaceId,
			actorId: humanId,
		})
		const reactions = await loadReactionsByMessage(db, humanId, ids)
		const summaries = await loadThreadSummaries(db, humanId, [root])
		const wire = (v: unknown) => JSON.parse(JSON.stringify(v))

		const rootRow = body.messages.find((m) => m.id === root.id)
		expect(rootRow?.spawned_sessions).toEqual(wire(spawned.get(root.id)))
		expect(rootRow?.spawned_sessions).toHaveLength(1)
		expect(rootRow?.thread).toEqual(wire(summaries.get(root.id) ?? null))
		expect(reactions.size).toBe(0)
		expect(body.pending_handoffs).toEqual(wire(pending))
		expect(body.pending_handoffs).toHaveLength(1)
	})

	it('still answers a non-participant with 404', async () => {
		const { conversation } = await seed()
		const stranger = await insertActor(db, { type: 'human' })
		if (!stranger) throw new Error('failed to seed actor')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: stranger.id, role: 'member' })
		const res = await createApp(stranger.id).request(
			jsonGet(`/api/conversations/${conversation.id}/messages`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(404)
	})

	it('runs no participant lookup beyond the auth join', async () => {
		const { conversation } = await seed()
		const captured: string[] = []
		const loggedDb = drizzle(sql, {
			schema,
			logger: { logQuery: (q) => captured.push(q) },
		}) as unknown as Database
		const res = await createApp(humanId, loggedDb).request(
			jsonGet(`/api/conversations/${conversation.id}/messages`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const participantLookups = captured.filter(
			(q) => q.includes('"conversation_participants"') && !q.includes('"conversations"'),
		)
		expect(participantLookups).toHaveLength(0)
		// auth join, page, spawned, reactions, thread (3), pending handoffs.
		expect(captured.length).toBe(8)
	})
})
