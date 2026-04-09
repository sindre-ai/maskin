import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, sessionLogs, sessions } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	buildCreateSessionBody,
	insertActor,
	insertSession,
	insertSessionLog,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: unknown
	}
}

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * Mock SessionManager that performs real DB operations without Docker.
 */
function createMockSessionManager(database: Database) {
	const emitter = new EventEmitter()

	return Object.assign(emitter, {
		async createSession(
			workspaceId: string,
			params: {
				actorId: string
				actionPrompt: string
				config?: Record<string, unknown>
				triggerId?: string
				createdBy: string
				autoStart?: boolean
			},
		) {
			const [session] = await database
				.insert(sessions)
				.values({
					workspaceId,
					actorId: params.actorId,
					triggerId: params.triggerId,
					status: 'pending',
					actionPrompt: params.actionPrompt,
					config: params.config ?? {},
					createdBy: params.createdBy,
				})
				.returning()

			await database.insert(events).values({
				workspaceId,
				actorId: params.actorId,
				action: 'session_created',
				entityType: 'session',
				entityId: session.id,
				data: {},
			})

			return session
		},

		async stopSession(sessionId: string) {
			const [session] = await database
				.select()
				.from(sessions)
				.where(eq(sessions.id, sessionId))
				.limit(1)

			if (!session || !['running', 'starting'].includes(session.status)) {
				throw new Error(`Session ${sessionId} is not in a stoppable state (${session?.status})`)
			}

			await database
				.update(sessions)
				.set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
				.where(eq(sessions.id, sessionId))
		},

		async pauseSession(sessionId: string) {
			const [session] = await database
				.select()
				.from(sessions)
				.where(eq(sessions.id, sessionId))
				.limit(1)

			if (!session || session.status !== 'running') {
				throw new Error(`Session ${sessionId} is not running (${session?.status})`)
			}

			await database
				.update(sessions)
				.set({
					status: 'paused',
					snapshotPath: `snapshots/${sessionId}.tar.gz`,
					containerId: null,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))
		},

		async resumeSession(sessionId: string) {
			const [session] = await database
				.select()
				.from(sessions)
				.where(eq(sessions.id, sessionId))
				.limit(1)

			if (!session || session.status !== 'paused') {
				throw new Error(`Session ${sessionId} is not paused (${session?.status})`)
			}

			await database
				.update(sessions)
				.set({
					status: 'running',
					containerId: `container-resumed-${sessionId}`,
					snapshotPath: null,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))
		},
	})
}

function createSessionApp() {
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
	const sessionManager = createMockSessionManager(db)

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route('/api/sessions', sessionsRoutes)
	return app
}

describe('Sessions Integration', () => {
	let workspaceId: string
	let agentActorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Test Agent' })
		agentActorId = agent.id
	})

	describe('Create + Get lifecycle', () => {
		it('creates a session and retrieves it by ID', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						actor_id: agentActorId,
						auto_start: false,
					}),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.status).toBe('pending')
			expect(created.actorId).toBe(agentActorId)
			expect(created.workspaceId).toBe(workspaceId)
			expect(created.actionPrompt).toBeDefined()

			// Get by ID
			const getRes = await app.request(jsonGet(`/api/sessions/${created.id}`, headers))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.id).toBe(created.id)
			expect(fetched.status).toBe('pending')
			expect(fetched.actorId).toBe(agentActorId)
		})
	})

	describe('List with filters', () => {
		it('lists sessions for workspace', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			await insertSession(db, workspaceId, agentActorId, getTestActorId(), { status: 'running' })
			await insertSession(db, workspaceId, agentActorId, getTestActorId(), { status: 'completed' })

			const res = await app.request(jsonGet('/api/sessions', headers))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(2)
		})

		it('filters by status', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			await insertSession(db, workspaceId, agentActorId, getTestActorId(), { status: 'running' })
			await insertSession(db, workspaceId, agentActorId, getTestActorId(), { status: 'running' })
			await insertSession(db, workspaceId, agentActorId, getTestActorId(), { status: 'completed' })

			const res = await app.request(jsonGet('/api/sessions?status=running', headers))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(2)
			for (const s of list) {
				expect(s.status).toBe('running')
			}
		})

		it('filters by actor_id', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const otherAgent = await insertActor(db, { type: 'agent', name: 'Other Agent' })

			await insertSession(db, workspaceId, agentActorId, getTestActorId())
			await insertSession(db, workspaceId, otherAgent.id, getTestActorId())

			const res = await app.request(jsonGet(`/api/sessions?actor_id=${agentActorId}`, headers))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(1)
			expect(list[0].actorId).toBe(agentActorId)
		})

		it('supports pagination', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			for (let i = 0; i < 3; i++) {
				await insertSession(db, workspaceId, agentActorId, getTestActorId())
			}

			const res = await app.request(jsonGet('/api/sessions?limit=2&offset=1', headers))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(2)
		})
	})

	describe('Get 404', () => {
		it('returns 404 for non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(jsonGet(`/api/sessions/${randomUUID()}`, headers))
			expect(res.status).toBe(404)
		})
	})

	describe('Stop lifecycle', () => {
		it('stops a running session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'running',
				containerId: 'fake-container-1',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, headers),
			)
			expect(res.status).toBe(200)
			const stopped = await res.json()
			expect(stopped.status).toBe('completed')
			expect(stopped.completedAt).toBeDefined()
		})
	})

	describe('Pause lifecycle', () => {
		it('pauses a running session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'running',
				containerId: 'fake-container-2',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, headers),
			)
			expect(res.status).toBe(200)
			const paused = await res.json()
			expect(paused.status).toBe('paused')
			expect(paused.snapshotPath).toBeDefined()
			expect(paused.containerId).toBeNull()
		})
	})

	describe('Resume lifecycle', () => {
		it('resumes a paused session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'paused',
				containerId: null,
				snapshotPath: 'snapshots/test.tar.gz',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, headers),
			)
			expect(res.status).toBe(200)
			const resumed = await res.json()
			expect(resumed.status).toBe('running')
			expect(resumed.containerId).toBeDefined()
			expect(resumed.snapshotPath).toBeNull()
		})
	})

	describe('Pause 400', () => {
		it('returns 400 when pausing a completed session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'completed',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, headers),
			)
			expect(res.status).toBe(400)
		})

		it('returns 400 when pausing an already paused session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'paused',
				snapshotPath: 'snapshots/existing.tar.gz',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, headers),
			)
			expect(res.status).toBe(400)
		})

		it('returns 404 when pausing a non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${randomUUID()}/pause`, undefined, headers),
			)
			expect(res.status).toBe(404)
		})
	})

	describe('Resume 400', () => {
		it('returns 400 when resuming a running session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'running',
				containerId: 'fake-container',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, headers),
			)
			expect(res.status).toBe(400)
		})

		it('returns 400 when resuming a completed session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'completed',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, headers),
			)
			expect(res.status).toBe(400)
		})

		it('returns 404 when resuming a non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${randomUUID()}/resume`, undefined, headers),
			)
			expect(res.status).toBe(404)
		})
	})

	describe('Stop 400', () => {
		it('returns 400 when stopping a completed session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'completed',
			})

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, headers),
			)
			expect(res.status).toBe(400)
		})
	})

	describe('Logs', () => {
		it('returns logs in ascending order', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const log1 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'line 1' })
			const log2 = await insertSessionLog(db, session.id, { stream: 'stderr', content: 'line 2' })
			const log3 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'line 3' })

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs`, headers))
			expect(res.status).toBe(200)
			const logs = await res.json()
			expect(logs).toHaveLength(3)
			// Ascending order by id
			expect(logs[0].id).toBe(log1.id)
			expect(logs[1].id).toBe(log2.id)
			expect(logs[2].id).toBe(log3.id)
		})

		it('filters by stream and since', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const log1 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'out 1' })
			await insertSessionLog(db, session.id, { stream: 'stderr', content: 'err 1' })
			const log3 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'out 2' })

			// Filter by stream
			const streamRes = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?stream=stdout`, headers),
			)
			expect(streamRes.status).toBe(200)
			const streamLogs = await streamRes.json()
			expect(streamLogs).toHaveLength(2)
			for (const l of streamLogs) {
				expect(l.stream).toBe('stdout')
			}

			// Filter by since
			const sinceRes = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?since=${log1.id}`, headers),
			)
			expect(sinceRes.status).toBe(200)
			const sinceLogs = await sinceRes.json()
			// Should return logs after log1 (i.e., log2 and log3)
			expect(sinceLogs).toHaveLength(2)
			expect(sinceLogs[0].id).toBeGreaterThan(log1.id)
		})

		it('returns 404 for logs of non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(jsonGet(`/api/sessions/${randomUUID()}/logs`, headers))
			expect(res.status).toBe(404)
		})
	})

	describe('Validation 400', () => {
		it('returns 400 when action_prompt is missing', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					{ actor_id: agentActorId, auto_start: false },
					headers,
				),
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('returns 400 when actor_id is not a valid UUID', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					{ actor_id: 'not-a-uuid', action_prompt: 'do something', auto_start: false },
					headers,
				),
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('returns 400 when body is empty', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(jsonRequest('POST', '/api/sessions', {}, headers))
			expect(res.status).toBe(400)
		})
	})

	describe('Workspace isolation', () => {
		it('cannot see sessions from another workspace via GET', async () => {
			const app = createSessionApp()

			// Create session in first workspace
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())

			// Create a second workspace
			const ws2 = await insertWorkspace(db, getTestActorId())
			const otherHeaders = { 'x-workspace-id': ws2.id }

			// Try to get session from second workspace
			const res = await app.request(jsonGet(`/api/sessions/${session.id}`, otherHeaders))
			expect(res.status).toBe(404)
		})

		it('cannot list sessions from another workspace', async () => {
			const app = createSessionApp()

			// Create sessions in first workspace
			await insertSession(db, workspaceId, agentActorId, getTestActorId())
			await insertSession(db, workspaceId, agentActorId, getTestActorId())

			// Create a second workspace and list from it
			const ws2 = await insertWorkspace(db, getTestActorId())
			const otherHeaders = { 'x-workspace-id': ws2.id }

			const res = await app.request(jsonGet('/api/sessions', otherHeaders))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(0)
		})

		it('cannot stop a session from another workspace', async () => {
			const app = createSessionApp()

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'running',
				containerId: 'fake-container',
			})

			const ws2 = await insertWorkspace(db, getTestActorId())
			const otherHeaders = { 'x-workspace-id': ws2.id }

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, otherHeaders),
			)
			expect(res.status).toBe(404)
		})
	})

	describe('Event audit trail', () => {
		it('creates session_created event after POST', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						actor_id: agentActorId,
						auto_start: false,
					}),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()

			const eventRows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, created.id), eq(events.action, 'session_created')))
			expect(eventRows).toHaveLength(1)
			expect(eventRows[0].entityType).toBe('session')
		})
	})
})
