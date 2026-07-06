import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { SessionManager } from '../../services/session-manager'
import {
	insertActor,
	insertConversation,
	insertConversationParticipant,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// Wires the real SessionManager (not a hand-rolled mock) so this test exercises the
// actual mapping from route params to the sessions.conversation_id column.
function createConversationsApp(sessionManager: SessionManager) {
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
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route('/api/conversations', conversationsRoutes)
	return app
}

// Regression coverage: POST /:id/messages used to spawn the @mentioned agent's
// session with the conversation id nested under `config.conversation_id` instead of
// the top-level `conversationId` param SessionManager.createSession maps to the
// sessions.conversation_id column. That left the column NULL, so the agent's reply
// was silently never persisted back into the conversation (SessionManager's
// accumulateTurnText gates on session.conversationId). This exercises the fixed
// wiring against real Postgres.
describe('POST /api/conversations/:id/messages — @mention session linking (Integration)', () => {
	it('spawns the mentioned agent session linked to the conversation via sessions.conversation_id', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const agent = await insertActor(db, { type: 'agent', name: 'Strategist' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const conv = await insertConversation(db, ws.id, { type: 'room', title: 'Room' })
		await insertConversationParticipant(db, conv.id, actorId)
		await insertConversationParticipant(db, conv.id, agent.id)

		const sessionManager = new SessionManager(db, stubStorage())
		const app = createConversationsApp(sessionManager)

		try {
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conv.id}/messages`,
					{ content: 'hey @Strategist take a look', mentions: [agent.id] },
					{ 'x-workspace-id': ws.id },
				),
			)
			expect(res.status).toBe(201)

			// The session spawn is fire-and-forget in the route; the INSERT inside
			// createSession is awaited before autoStart fires, but give the microtask
			// queue a tick to run since we don't await it directly here.
			await new Promise((resolve) => setImmediate(resolve))

			const [spawned] = await db.select().from(sessions).where(eq(sessions.actorId, agent.id))
			expect(spawned).toBeDefined()
			expect(spawned?.conversationId).toBe(conv.id)
		} finally {
			await sessionManager.stop()
		}
	})
})
