import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { _resetListReadCache } from '../../lib/list-read-cache'
import { listReadCache } from '../../middleware/list-read-cache'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

// One app, two callers: the x-test-actor header stands in for what authMiddleware proves.
function createApp() {
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })

	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', c.req.header('x-test-actor') as string)
		c.set('actorType', 'human')
		c.set('sessionManager' as never, sessionManager as never)
		await next()
	})
	app.use('*', listReadCache())
	app.route('/api/conversations', conversationsRoutes)
	app.route('/api/actors', actorsRoutes)
	return app
}

describe('List read cache Integration', () => {
	let ownerId: string
	let otherId: string
	let workspaceId: string
	let app: ReturnType<typeof createApp>

	const call = (actorId: string, method: string, path: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: {
				'content-type': 'application/json',
				'x-test-actor': actorId,
				'x-workspace-id': workspaceId,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})

	type ListedConversation = { id: string; title: string; pinned: boolean; unread_count: number }
	const listChats = async (actorId: string, query = '') => {
		const res = await call(actorId, 'GET', `/api/conversations${query}`)
		expect(res.status).toBe(200)
		return ((await res.json()) as { conversations: ListedConversation[] }).conversations
	}
	// The list can hold chats this test did not create, so the tests that count chats look only at their own.
	const listOwn = async (actorId: string, ids: string[]) =>
		(await listChats(actorId)).filter((c) => ids.includes(c.id))
	const createChat = async (actorId: string, title: string, participants: string[] = []) => {
		const res = await call(actorId, 'POST', '/api/conversations', {
			title,
			participant_actor_ids: participants,
		})
		expect(res.status).toBe(201)
		return (await res.json()) as { id: string }
	}

	beforeEach(async () => {
		_resetListReadCache()
		ownerId = getTestActorId()
		const other = await insertActor(db, { type: 'human' })
		otherId = other.id
		workspaceId = (await insertWorkspace(db, ownerId)).id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: otherId, role: 'member' })
		app = createApp()
	})

	it('serves each person their own chat list, repeat reads from the cache', async () => {
		const shared = await createChat(ownerId, 'Shared')
		const ownerOnly = await createChat(ownerId, 'Owner only')
		const own = [shared.id, ownerOnly.id]
		await call(ownerId, 'POST', `/api/conversations/${shared.id}/participants`, {
			actor_ids: [otherId],
		})

		const ownerFirst = await listOwn(ownerId, own)
		const otherFirst = await listOwn(otherId, own)
		expect(ownerFirst.map((c) => c.title).sort()).toEqual(['Owner only', 'Shared'])
		expect(otherFirst.map((c) => c.title)).toEqual(['Shared'])

		// Changed behind the cache's back (no request, so no eviction): repeat reads still answer
		// from the cache, and each person still gets their own body.
		await db.update(conversations).set({ title: 'Renamed' }).where(eq(conversations.id, shared.id))
		expect(await listOwn(ownerId, own)).toEqual(ownerFirst)
		expect(await listOwn(otherId, own)).toEqual(otherFirst)
	})

	it('gives a removed member no stale hit', async () => {
		const chat = await createChat(ownerId, 'Leaving soon', [otherId])
		expect((await listOwn(otherId, [chat.id])).map((c) => c.id)).toEqual([chat.id])

		const removed = await call(
			ownerId,
			'DELETE',
			`/api/conversations/${chat.id}/participants/${otherId}`,
		)
		expect(removed.status).toBe(204)

		expect(await listOwn(otherId, [chat.id])).toEqual([])
		// The owner still has it.
		expect((await listOwn(ownerId, [chat.id])).map((c) => c.id)).toEqual([chat.id])
	})

	it('shows a person their own write straight away', async () => {
		const chat = await createChat(ownerId, 'Pin me', [otherId])
		expect((await listChats(otherId))[0]?.pinned).toBe(false)

		const pinned = await call(otherId, 'PATCH', `/api/conversations/${chat.id}/me`, {
			pinned: true,
		})
		expect(pinned.status).toBe(200)

		expect((await listChats(otherId))[0]?.pinned).toBe(true)
	})

	it('shows a person the unread list change as soon as they mark a chat read', async () => {
		const chat = await createChat(ownerId, 'Unread', [otherId])
		const post = await call(ownerId, 'POST', `/api/conversations/${chat.id}/messages`, {
			content: 'ping',
		})
		expect(post.status).toBe(201)
		const posted = (await post.json()) as { id: number }

		expect((await listChats(otherId, '?unread_only=true')).map((c) => c.id)).toEqual([chat.id])

		const read = await call(otherId, 'PATCH', `/api/conversations/${chat.id}/me`, {
			last_read_message_id: posted.id,
		})
		expect(read.status).toBe(200)

		expect(await listChats(otherId, '?unread_only=true')).toEqual([])
	})

	it('shows a person their own actor edit in the actors list straight away', async () => {
		const read = async () => {
			const res = await call(otherId, 'GET', '/api/actors')
			expect(res.status).toBe(200)
			const rows = (await res.json()) as Array<{ id: string; description: string | null }>
			return rows.find((a) => a.id === otherId)?.description
		}
		expect(await read()).not.toBe('Back on Monday')

		const edit = await call(otherId, 'PATCH', `/api/actors/${otherId}`, {
			description: 'Back on Monday',
		})
		expect(edit.status).toBe(200)

		expect(await read()).toBe('Back on Monday')
	})
})
