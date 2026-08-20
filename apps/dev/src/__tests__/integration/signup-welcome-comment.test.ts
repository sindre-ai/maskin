import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { buildSignupCaptureKnowledge } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')

const KNOWLEDGE_WORKSPACE_SETTINGS = {
	enabled_modules: ['work', 'knowledge'],
	display_names: {
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
		loop: 'Loop',
		knowledge: 'Knowledge',
	},
	statuses: {
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
		loop: ['holding', 'at-risk', 'breached'],
		knowledge: ['draft', 'validated', 'deprecated'],
	},
	field_definitions: {},
	relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates', 'about'],
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

function createObjectsApp(sessionManager: SessionManager) {
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

	app.route('/api/objects', objectsRoutes)
	app.route('/api/subscriptions', subscriptionsRoutes)
	return app
}

async function seedAgent(workspaceId: string, name: string) {
	const agent = await insertActor(db, { type: 'agent', name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

describe('Signup welcome comment — Chief of Staff comments, Researcher gets spawned', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: KNOWLEDGE_WORKSPACE_SETTINGS,
		})
		workspaceId = ws.id
	})

	it('posts a Chief-of-Staff comment mentioning Researcher and the signed-up human, and spawns a Researcher session', async () => {
		const chief = await seedAgent(workspaceId, 'Chief of Staff')
		const researcher = await seedAgent(workspaceId, 'Researcher')
		const humanActorId = getTestActorId()
		const sessionManager = {
			createSession: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager
		const app = createObjectsApp(sessionManager)

		const payload = buildSignupCaptureKnowledge({
			name: 'Ada Testowski',
			organization: 'Acme Robotics',
			role: 'Head of Product',
		})

		const res = await app.request(
			jsonRequest('POST', '/api/objects', payload, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		await vi.waitFor(() => {
			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		const [commentEvent] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'commented')))
		expect(commentEvent).toBeDefined()
		expect(commentEvent.actorId).toBe(chief.id)
		const data = commentEvent.data as { content: string; mentions: string[] }
		expect(data.mentions).toEqual(expect.arrayContaining([researcher.id, humanActorId]))
		expect(data.mentions).toHaveLength(2)
		expect(data.content).toContain('Ada Testowski')
		expect(data.content).toContain('@Researcher')

		expect(sessionManager.createSession).toHaveBeenCalledWith(
			workspaceId,
			expect.objectContaining({
				actorId: researcher.id,
				createdBy: chief.id,
				actionPrompt: expect.stringContaining(created.id),
			}),
		)
		// Only Researcher (the agent mention) gets a spawned session — the human
		// mention must never trigger one.
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1)

		// The human mention is what makes this comment surface on their For You
		// page: GET /api/subscriptions/unread matches on events.data.mentions
		// containing the viewer's actor id.
		const unreadRes = await app.request(
			jsonRequest('GET', '/api/subscriptions/unread', undefined, { 'x-workspace-id': workspaceId }),
		)
		expect(unreadRes.status).toBe(200)
		const unread = (await unreadRes.json()) as {
			items: Array<{ entity_id: string; mentioning_unread_count: number }>
		}
		const item = unread.items.find((i) => i.entity_id === created.id)
		expect(item).toBeDefined()
		expect(item?.mentioning_unread_count).toBeGreaterThan(0)
	})

	it('does not trigger a comment or session for a knowledge object that is not signup_capture', async () => {
		await seedAgent(workspaceId, 'Chief of Staff')
		await seedAgent(workspaceId, 'Researcher')
		const sessionManager = {
			createSession: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager
		const app = createObjectsApp(sessionManager)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/objects',
				{ type: 'knowledge', title: 'Some other knowledge', status: 'validated' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		// Give any stray fire-and-forget work a moment, then assert nothing fired.
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sessionManager.createSession).not.toHaveBeenCalled()

		const commentEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'commented')))
		expect(commentEvents).toHaveLength(0)
	})

	it('gracefully skips when Chief of Staff / Researcher are not seeded in the workspace', async () => {
		const sessionManager = {
			createSession: vi.fn().mockResolvedValue(undefined),
		} as unknown as SessionManager
		const app = createObjectsApp(sessionManager)

		const payload = buildSignupCaptureKnowledge({
			name: 'Ada Testowski',
			organization: 'Acme Robotics',
			role: 'Head of Product',
		})

		const res = await app.request(
			jsonRequest('POST', '/api/objects', payload, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sessionManager.createSession).not.toHaveBeenCalled()

		const commentEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, created.id), eq(events.action, 'commented')))
		expect(commentEvents).toHaveLength(0)
	})
})
