import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, sessionLogs, sessions } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import {
	buildCreateSessionBody,
	insertActor,
	insertSession,
	insertSessionLog,
	insertTrigger,
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
				sourceSessionId?: string
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
					sourceSessionId: params.sourceSessionId,
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
					snapshotPath: `snapshots/${sessionId}.tar`,
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
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })

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

			const target = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			await insertSession(db, workspaceId, otherAgent.id, getTestActorId())

			const res = await app.request(jsonGet(`/api/sessions?actor_id=${agentActorId}`, headers))
			expect(res.status).toBe(200)
			const list = await res.json()
			expect(list).toHaveLength(1)
			// Lean shape doesn't carry actorId; assert on id instead — proves the
			// filter narrows to the specific agent's session, not just to one row.
			expect(list[0].id).toBe(target.id)
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

		describe('updated_before / updated_after filters (AC-T3)', () => {
			const T = new Date('2026-06-20T12:00:00.000Z')
			const before = new Date(T.getTime() - 60_000)
			const after = new Date(T.getTime() + 60_000)

			async function seedThree() {
				const old = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					updatedAt: before,
				})
				const mid = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					updatedAt: T,
				})
				const fresh = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					updatedAt: after,
				})
				return { old, mid, fresh }
			}

			it('one-second boundary on either side behaves identically to objects', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const { mid } = await seedThree()

				const justAfter = new Date(T.getTime() + 1_000).toISOString()
				const includeRes = await app.request(
					jsonGet(`/api/sessions?updated_before=${encodeURIComponent(justAfter)}`, headers),
				)
				expect(includeRes.status).toBe(200)
				const includeBody = (await includeRes.json()) as Array<{ id: string }>
				expect(includeBody.map((r) => r.id)).toContain(mid.id)

				const justBefore = new Date(T.getTime() - 1_000).toISOString()
				const excludeRes = await app.request(
					jsonGet(`/api/sessions?updated_before=${encodeURIComponent(justBefore)}`, headers),
				)
				const excludeBody = (await excludeRes.json()) as Array<{ id: string }>
				expect(excludeBody.map((r) => r.id)).not.toContain(mid.id)
			})

			it('half-open bound excludes rows at the exact instant on both sides', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const { mid } = await seedThree()

				const cutoff = T.toISOString()
				const beforeRes = await app.request(
					jsonGet(`/api/sessions?updated_before=${encodeURIComponent(cutoff)}`, headers),
				)
				const beforeBody = (await beforeRes.json()) as Array<{ id: string }>
				expect(beforeBody.map((r) => r.id)).not.toContain(mid.id)

				const afterRes = await app.request(
					jsonGet(`/api/sessions?updated_after=${encodeURIComponent(cutoff)}`, headers),
				)
				const afterBody = (await afterRes.json()) as Array<{ id: string }>
				expect(afterBody.map((r) => r.id)).not.toContain(mid.id)
			})

			it('response is unchanged when neither param is set (AC-T7 parity on sessions)', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				await seedThree()

				const baseline = await app.request(jsonGet('/api/sessions', headers))
				const withDefaults = await app.request(jsonGet('/api/sessions', headers))
				expect(await baseline.text()).toBe(await withDefaults.text())
			})

			it('rejects malformed updated_before with 400 (AC-T6 on sessions)', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const res = await app.request(jsonGet('/api/sessions?updated_before=not-a-date', headers))
				expect(res.status).toBe(400)
			})
		})

		describe('lean rows + verbose flag + trigger_id', () => {
			it("returns lean rows { id, title, status, updated_at } by default and today's payload on verbose=true", async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }

				await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					actionPrompt: 'Do the thing',
					status: 'running',
				})

				const leanRes = await app.request(jsonGet('/api/sessions', headers))
				expect(leanRes.status).toBe(200)
				const leanBody = (await leanRes.json()) as Array<Record<string, unknown>>
				expect(leanBody).toHaveLength(1)
				expect(Object.keys(leanBody[0]).sort()).toEqual(['id', 'status', 'title', 'updated_at'])
				expect(leanBody[0].status).toBe('running')

				const verboseRes = await app.request(jsonGet('/api/sessions?verbose=true', headers))
				expect(verboseRes.status).toBe(200)
				const verboseBody = (await verboseRes.json()) as Array<Record<string, unknown>>
				expect(verboseBody).toHaveLength(1)
				// The verbose payload keeps every field today's list emits — this is
				// the regression pin the tech spec calls out (§4 backwards-compat).
				const row = verboseBody[0]
				for (const key of [
					'id',
					'workspaceId',
					'actorId',
					'status',
					'actionPrompt',
					'config',
					'currentActivity',
					'startedAt',
					'completedAt',
					'timeoutAt',
					'createdBy',
					'createdAt',
					'updatedAt',
				]) {
					expect(row).toHaveProperty(key)
				}
				// Lean-only keys stay off the verbose payload.
				expect(row).not.toHaveProperty('title')
				expect(row).not.toHaveProperty('updated_at')
			})

			it('lean list is at least 5x smaller than verbose for the same rows', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }

				// Seed 20 rows with realistic-sized action prompts + config blobs so
				// the fat serialization has something to compare against.
				const bigPrompt =
					'Investigate the flaky login test on staging, then trace every failing assertion back to whichever fixture set them up and file a task for each root cause you find.'
				const bigConfig = {
					runtime: 'claude-code',
					runtime_config: { max_turns: 20 },
					timeout_seconds: 600,
					memory_mb: 4096,
					cpu_shares: 1024,
					mcps: [],
					env_vars: { FOO: 'bar', BAZ: 'qux' },
					interactive: false,
					entry_agent_role: 'chief-of-staff',
				}
				for (let i = 0; i < 20; i++) {
					await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
						actionPrompt: bigPrompt,
						config: bigConfig,
					})
				}

				const leanRes = await app.request(jsonGet('/api/sessions?limit=20', headers))
				expect(leanRes.status).toBe(200)
				const leanText = await leanRes.text()

				const verboseRes = await app.request(
					jsonGet('/api/sessions?verbose=true&limit=20', headers),
				)
				expect(verboseRes.status).toBe(200)
				const verboseText = await verboseRes.text()

				// Serialized size ratio: fat / lean ≥ 5. This is the measurable
				// success criterion the parent bet targets (bytes-per-row ≤ 50%
				// of pre-ship baseline in PostHog).
				expect(verboseText.length / leanText.length).toBeGreaterThanOrEqual(5)
			})

			it('filters by trigger_id and synthesizes the title from the trigger name', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const trigger = await insertTrigger(db, workspaceId, getTestActorId(), agentActorId, {
					name: 'Nightly triage sweep',
				})

				const target = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					triggerId: trigger.id,
					actionPrompt: 'Some prompt the trigger sent',
				})
				// Sibling session on the same actor but no trigger — must not match.
				await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					actionPrompt: 'A different one',
				})

				const res = await app.request(jsonGet(`/api/sessions?trigger_id=${trigger.id}`, headers))
				expect(res.status).toBe(200)
				const list = (await res.json()) as Array<{
					id: string
					title: string
					status: string
					updated_at: string | null
				}>
				expect(list).toHaveLength(1)
				expect(list[0].id).toBe(target.id)
				// Title synthesis prefers the trigger's name over actionPrompt.
				expect(list[0].title).toBe('Nightly triage sweep')
			})

			it('lean row title falls back to actionPrompt when no trigger is joined', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const prompt = 'Reproduce the flaky test and file a task'
				await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					actionPrompt: prompt,
				})

				const res = await app.request(jsonGet('/api/sessions', headers))
				expect(res.status).toBe(200)
				const list = (await res.json()) as Array<{ title: string }>
				expect(list).toHaveLength(1)
				expect(list[0].title).toBe(prompt)
			})

			it('supports the before cursor: rows with updated_at < before are returned', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const early = new Date('2026-06-01T10:00:00.000Z')
				const late = new Date('2026-06-01T14:00:00.000Z')
				const earlySession = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					updatedAt: early,
				})
				await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					updatedAt: late,
				})

				const cutoff = new Date('2026-06-01T12:00:00.000Z').toISOString()
				const res = await app.request(
					jsonGet(`/api/sessions?before=${encodeURIComponent(cutoff)}`, headers),
				)
				expect(res.status).toBe(200)
				const list = (await res.json()) as Array<{ id: string }>
				expect(list.map((r) => r.id)).toEqual([earlySession.id])
			})

			it('walking pages with before=<last updated_at> visits every row exactly once', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				// Created oldest but updated most recently: a created_at sort would bury it
				// on the last page, where the updated_at cursor then excludes it.
				const longLived = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
					createdAt: new Date('2026-06-01T08:00:00.000Z'),
					updatedAt: new Date('2026-06-01T20:00:00.000Z'),
				})
				const seeded = [longLived.id]
				for (let i = 1; i <= 5; i++) {
					const hour = String(8 + i).padStart(2, '0')
					const s = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
						createdAt: new Date(`2026-06-01T${hour}:00:00.000Z`),
						updatedAt: new Date(`2026-06-01T${hour}:30:00.000Z`),
					})
					seeded.push(s.id)
				}

				const seen: string[] = []
				let cursor: string | undefined
				for (let page = 0; page < 5; page++) {
					const qs = `limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`
					const res = await app.request(jsonGet(`/api/sessions?${qs}`, headers))
					expect(res.status).toBe(200)
					const rows = (await res.json()) as Array<{ id: string; updated_at: string }>
					if (rows.length === 0) break
					seen.push(...rows.map((r) => r.id))
					cursor = rows[rows.length - 1].updated_at
				}

				expect([...seen].sort()).toEqual([...seeded].sort())
				expect(seen[0]).toBe(longLived.id)
			})

			it('cap on limit is 200; requests over 200 are rejected', async () => {
				const app = createSessionApp()
				const headers = { 'x-workspace-id': workspaceId }
				const res = await app.request(jsonGet('/api/sessions?limit=500', headers))
				expect(res.status).toBe(400)
			})
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

		it('pages backward with the before cursor', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			if (!session) throw new Error('no session')
			const log1 = await insertSessionLog(db, session.id, { content: 'one' })
			const log2 = await insertSessionLog(db, session.id, { content: 'two' })
			const log3 = await insertSessionLog(db, session.id, { content: 'three' })
			if (!log1 || !log2 || !log3) throw new Error('no logs')

			// `since` can only walk forward, so it cannot reach the earlier
			// history of a session a client only hydrated the tail of.
			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?before=${log3.id}`, headers),
			)
			expect(res.status).toBe(200)
			const logs = await res.json()
			expect(logs.map((l: { id: number }) => l.id)).toEqual([log1.id, log2.id])
		})

		it('takes the newest rows below the before cursor, still ascending', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			if (!session) throw new Error('no session')
			const seeded = []
			for (let i = 0; i < 5; i++) {
				seeded.push(await insertSessionLog(db, session.id, { content: `line ${i}` }))
			}
			const last = seeded[4]
			if (!last) throw new Error('no logs')

			// The caller is walking backward and wants the page immediately
			// preceding what it holds — not the oldest rows in the session.
			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?before=${last.id}&limit=2`, headers),
			)
			const logs = await res.json()
			expect(logs.map((l: { id: number }) => l.id)).toEqual([seeded[2]?.id, seeded[3]?.id])
		})

		it('supports a bounded window when before and since are combined', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			if (!session) throw new Error('no session')
			const seeded = []
			for (let i = 0; i < 4; i++) {
				seeded.push(await insertSessionLog(db, session.id, { content: `line ${i}` }))
			}
			const res = await app.request(
				jsonGet(
					`/api/sessions/${session.id}/logs?since=${seeded[0]?.id}&before=${seeded[3]?.id}`,
					headers,
				),
			)
			const logs = await res.json()
			expect(logs.map((l: { id: number }) => l.id)).toEqual([seeded[1]?.id, seeded[2]?.id])
		})

		it('returns an empty page when before is past the start of the session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			if (!session) throw new Error('no session')
			const log1 = await insertSessionLog(db, session.id, { content: 'one' })
			if (!log1) throw new Error('no log')

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?before=${log1.id}`, headers),
			)
			expect(res.status).toBe(200)
			// This is how the client learns it has reached the beginning.
			expect(await res.json()).toEqual([])
		})

		// A long-lived interactive chat session accumulates logs for the whole
		// conversation. The default `asc` ordering combined with `limit` hands
		// back the OLDEST rows, which pinned the chat transcript to the start
		// of the conversation once a session passed the limit — the live turn
		// was permanently outside the window. `order=desc` takes the newest
		// rows instead, still returned oldest-first.
		it('returns the newest rows, in ascending order, when order=desc', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const inserted = []
			for (let i = 1; i <= 5; i++) {
				inserted.push(
					await insertSessionLog(db, session.id, { stream: 'stdout', content: `line ${i}` }),
				)
			}

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs?order=desc&limit=2`, headers),
			)
			expect(res.status).toBe(200)
			const logs = await res.json()

			// The last two rows — not the first two.
			expect(logs).toHaveLength(2)
			expect(logs[0].id).toBe(inserted[3]?.id)
			expect(logs[1].id).toBe(inserted[4]?.id)
			expect(logs[0].id).toBeLessThan(logs[1].id)
		})

		it('returns the oldest rows when limit is applied without order=desc', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const inserted = []
			for (let i = 1; i <= 5; i++) {
				inserted.push(
					await insertSessionLog(db, session.id, { stream: 'stdout', content: `line ${i}` }),
				)
			}

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs?limit=2`, headers))
			const logs = await res.json()
			expect(logs).toHaveLength(2)
			expect(logs[0].id).toBe(inserted[0]?.id)
			expect(logs[1].id).toBe(inserted[1]?.id)
		})

		it('returns 404 for logs of non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(jsonGet(`/api/sessions/${randomUUID()}/logs`, headers))
			expect(res.status).toBe(404)
		})
	})

	describe('Deep log read — /api/sessions/:id/logs/deep', () => {
		it('newest_first pages backward through history covering every row exactly once', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())

			// Seed 500 log rows. bigserial ids are monotonic, so the sequence
			// is a stable ordered set we can reason about.
			const seeded: { id: number }[] = []
			for (let i = 0; i < 500; i++) {
				const row = await insertSessionLog(db, session.id, { content: `line ${i}` })
				if (row) seeded.push(row)
			}
			expect(seeded).toHaveLength(500)

			// Walk backward via before_id five times at limit=100. Each page
			// must be contiguous with the last and cover every seeded row
			// exactly once between them (500 / 100 = 5 pages).
			const pages: number[][] = []
			let cursor: number | undefined
			for (let i = 0; i < 5; i++) {
				const url = `/api/sessions/${session.id}/logs/deep?limit=100${
					cursor !== undefined ? `&before_id=${cursor}` : ''
				}`
				const res = await app.request(jsonGet(url, headers))
				expect(res.status).toBe(200)
				const page = (await res.json()) as { id: number }[]
				expect(page).toHaveLength(100)
				const first = page[0]
				const last = page[page.length - 1]
				if (!first || !last) throw new Error('page is empty')
				// Response order is id DESC on newest_first — NOT reversed.
				expect(first.id).toBeGreaterThan(last.id)
				pages.push(page.map((r) => r.id))
				cursor = last.id
			}

			// Concatenate the five pages and assert they cover every seeded id
			// exactly once. Sort ascending for the equality check.
			const all = pages.flat().sort((a, b) => a - b)
			const expected = seeded.map((r) => r.id).sort((a, b) => a - b)
			expect(all).toEqual(expected)
			// And a hard uniqueness check — no id appears twice across pages.
			expect(new Set(all).size).toBe(500)
		})

		it('oldest_first with no cursor returns boot lines first (id ASC)', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const seeded: { id: number }[] = []
			for (let i = 0; i < 5; i++) {
				const row = await insertSessionLog(db, session.id, { content: `line ${i}` })
				if (row) seeded.push(row)
			}

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs/deep?direction=oldest_first&limit=3`, headers),
			)
			expect(res.status).toBe(200)
			const page = (await res.json()) as { id: number }[]
			expect(page.map((r) => r.id)).toEqual([seeded[0]?.id, seeded[1]?.id, seeded[2]?.id])
		})

		it('after_id tails the newest rows above the cursor', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const seeded: { id: number }[] = []
			for (let i = 0; i < 10; i++) {
				const row = await insertSessionLog(db, session.id, { content: `line ${i}` })
				if (row) seeded.push(row)
			}
			const cursor = seeded[5]?.id
			if (!cursor) throw new Error('seeded row missing')

			const res = await app.request(
				jsonGet(
					`/api/sessions/${session.id}/logs/deep?direction=newest_first&after_id=${cursor}`,
					headers,
				),
			)
			expect(res.status).toBe(200)
			const page = (await res.json()) as { id: number }[]
			// Rows satisfy id > cursor, so seeded[6..9].
			expect(page.every((r) => r.id > cursor)).toBe(true)
			expect(page).toHaveLength(4)
		})

		it('stream filter narrows the where clause', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			await insertSessionLog(db, session.id, { stream: 'stdout', content: 'out 1' })
			await insertSessionLog(db, session.id, { stream: 'stderr', content: 'err 1' })
			await insertSessionLog(db, session.id, { stream: 'stdout', content: 'out 2' })

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs/deep?stream=stderr`, headers),
			)
			expect(res.status).toBe(200)
			const page = (await res.json()) as { stream: string }[]
			expect(page).toHaveLength(1)
			expect(page[0]?.stream).toBe('stderr')
		})

		it('does NOT change /api/sessions/:id/logs semantics (regression pin for spec §8 rabbit hole 5)', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const seeded: { id: number }[] = []
			for (let i = 0; i < 3; i++) {
				const row = await insertSessionLog(db, session.id, { content: `line ${i}` })
				if (row) seeded.push(row)
			}

			// Old endpoint still returns ascending order.
			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs`, headers))
			expect(res.status).toBe(200)
			const page = (await res.json()) as { id: number }[]
			expect(page.map((r) => r.id)).toEqual(seeded.map((r) => r.id))
		})

		it('returns 404 for a non-existent session', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(jsonGet(`/api/sessions/${randomUUID()}/logs/deep`, headers))
			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/sessions/:id — include_logs bug fix (routes/sessions.ts:309)', () => {
		it('include_logs=true returns a logs array ordered newest-first and honors log_limit', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			const seeded: { id: number }[] = []
			for (let i = 0; i < 10; i++) {
				const row = await insertSessionLog(db, session.id, { content: `line ${i}` })
				if (row) seeded.push(row)
			}

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}?include_logs=true&log_limit=3`, headers),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { id: string; logs: { id: number }[] }
			expect(body.id).toBe(session.id)
			expect(body.logs).toHaveLength(3)
			// Newest first — the last three seeded rows, in DESC id order.
			expect(body.logs.map((l) => l.id)).toEqual([seeded[9]?.id, seeded[8]?.id, seeded[7]?.id])
		})

		it('include_logs omitted returns session with no logs key', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }
			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId())
			await insertSessionLog(db, session.id, { content: 'seed' })

			const res = await app.request(jsonGet(`/api/sessions/${session.id}`, headers))
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect('logs' in body).toBe(false)
		})
	})

	describe('Logs stream (SSE) — terminal-session replay honors Last-Event-ID', () => {
		it('replays every log when no Last-Event-ID is provided', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'completed',
			})
			const log1 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'line 1' })
			const log2 = await insertSessionLog(db, session.id, { stream: 'stdout', content: 'line 2' })

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs/stream`, headers))

			expect(res.status).toBe(200)
			const text = await res.text()
			expect(text).toContain('line 1')
			expect(text).toContain('line 2')
			expect(text).toContain(`id: ${log1.id}`)
			expect(text).toContain(`id: ${log2.id}`)
			expect(text).toContain('event: done')
			expect(text).toContain('data: completed')
		})

		it('does not re-emit rows the client already drained (regression: reload duplicated the transcript)', async () => {
			const app = createSessionApp()

			const session = await insertSession(db, workspaceId, agentActorId, getTestActorId(), {
				status: 'completed',
			})
			await insertSessionLog(db, session.id, { stream: 'stdout', content: 'first turn' })
			const log2 = await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: 'second turn',
			})
			const log3 = await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: 'third turn',
			})

			// Simulates a client that already hydrated "first turn" + "second turn"
			// via GET /logs (persisted sessionId + reload), then reconnects SSE with
			// Last-Event-ID set to the last id it already rendered.
			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs/stream`, {
					'x-workspace-id': workspaceId,
					'Last-Event-ID': String(log2.id),
				}),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			expect(text).not.toContain('first turn')
			expect(text).not.toContain('second turn')
			expect(text).toContain('third turn')
			expect(text).toContain(`id: ${log3.id}`)
			expect(text).toContain('event: done')
			expect(text).toContain('data: completed')
		})
	})

	describe('sourceSessionId', () => {
		it('stores source_session_id on the session row and returns it', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create a source session directly in the DB.
			const sourceSession = await insertSession(db, workspaceId, agentActorId, getTestActorId())

			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						actor_id: agentActorId,
						auto_start: false,
						source_session_id: sourceSession.id,
					}),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.sourceSessionId).toBe(sourceSession.id)

			// Confirm it's persisted in the DB row.
			const [row] = await db
				.select({ sourceSessionId: sessions.sourceSessionId })
				.from(sessions)
				.where(eq(sessions.id, created.id))
			expect(row.sourceSessionId).toBe(sourceSession.id)
		})

		it('returns 400 when source_session_id is not a valid UUID', async () => {
			const app = createSessionApp()
			const headers = { 'x-workspace-id': workspaceId }

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						actor_id: agentActorId,
						auto_start: false,
						source_session_id: 'not-a-uuid',
					}),
					headers,
				),
			)
			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
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
