import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import {
	events,
	actors,
	agentFiles,
	agentSkills,
	files,
	imports,
	notifications,
	readState,
	sessions,
	subscriptions,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { ACTOR_DESCRIPTION_MAX_LENGTH, ACTOR_DESCRIPTION_MAX_STORED_LENGTH } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import {
	buildAgentFile,
	buildFile,
	buildImport,
	buildReadState,
	buildSubscription,
	buildWorkspaceSkill,
	insertActor,
	insertNotification,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, setTestAgentStorage } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: eventsRoutes } = await import('../../routes/events')
const { AgentStorageManager } = await import('../../services/agent-storage')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Actors Integration — GET /:id', () => {
	it('includes id and name of attached workspace skills', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Skilled Agent' })
		const [skill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId: ws.id, createdBy: getTestActorId() }))
			.returning()
		await db.insert(agentSkills).values({ actorId: agent.id, workspaceSkillId: skill.id })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([{ id: skill.id, name: skill.name }])
	})

	it('returns an empty skills array when no skills are attached', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Skill-less Agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.skills).toEqual([])
	})
})

describe('Actors Integration — PATCH /:id description', () => {
	// Profile's "How to work with me" writes multi-paragraph prose into this
	// same column. It was bounded by the 80-character agent tagline length, so
	// anything a human actually typed 400'd and their text was discarded.
	// Profile edits the *caller's own* actor. A human PATCHing a different human
	// is the admin path and needs an X-Workspace-Id header, so writing this
	// against a freshly inserted human would 403 on the workspace-context guard
	// long before the length bound is reached.
	it('accepts a description longer than the agent tagline cap', async () => {
		const app = createApp()
		const self = getTestActorId()
		const prose = `${'Ask before emailing anyone. '.repeat(20)}

Never ship on a Friday.`
		expect(prose.length).toBeGreaterThan(ACTOR_DESCRIPTION_MAX_LENGTH)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${self}`, { description: prose }),
		)
		expect(res.status).toBe(200)

		const [row] = await db.select().from(actors).where(eq(actors.id, self))
		expect(row.description).toBe(prose)
	})

	it('still rejects a description past the storage bound', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${getTestActorId()}`, {
				description: 'x'.repeat(ACTOR_DESCRIPTION_MAX_STORED_LENGTH + 1),
			}),
		)
		expect(res.status).toBe(400)
	})
})

describe('Actors Integration — by-id routes are scoped to the caller workspaces', () => {
	const fakeTools = {
		mcpServers: { fake: { type: 'http', url: 'https://example.invalid/mcp' } },
	}

	async function seedAgentInWorkspaceOf(ownerId: string, callerRole?: 'member' | 'admin') {
		const ws = await insertWorkspace(db, ownerId)
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Scoped Agent',
			systemPrompt: 'original prompt',
			tools: { mcpServers: {} },
			llmConfig: { model: 'original-model' },
		})
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		if (callerRole) {
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: getTestActorId(), role: callerRole })
		}
		return { ws, agent }
	}

	async function readAgent(id: string) {
		const [row] = await db.select().from(actors).where(eq(actors.id, id))
		return row
	}

	it('GET returns 404 for an agent that only lives in a workspace the caller is not in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))

		expect(res.status).toBe(404)
	})

	it('GET returns 404 when the header names a workspace the caller is in but the agent is not', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)
		const mine = await insertWorkspace(db, getTestActorId())

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': mine.id }))

		expect(res.status).toBe(404)
	})

	it('GET returns 200 for an agent in a shared workspace, with and without the header', async () => {
		const app = createApp()
		const { ws, agent } = await seedAgentInWorkspaceOf(getTestActorId())

		const bare = await app.request(jsonGet(`/api/actors/${agent.id}`))
		const headed = await app.request(
			jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': ws.id }),
		)

		expect(bare.status).toBe(200)
		expect(headed.status).toBe(200)
	})

	it('PATCH returns 404 and leaves the row unchanged for an agent in a workspace the caller is not in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				system_prompt: 'changed prompt',
				tools: fakeTools,
				llm_config: { model: 'changed-model' },
			}),
		)

		expect(res.status).toBe(404)
		const row = await readAgent(agent.id)
		expect(row.systemPrompt).toBe('original prompt')
		expect(row.tools).toEqual({ mcpServers: {} })
		expect(row.llmConfig).toEqual({ model: 'original-model' })
	})

	it('PATCH returns 403 and leaves tools and llm_config unchanged for a plain member of the shared workspace', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')

		const toolsRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tools: fakeTools }),
		)
		const llmRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { llm_config: { model: 'changed-model' } }),
		)

		expect(toolsRes.status).toBe(403)
		expect(llmRes.status).toBe(403)
		const row = await readAgent(agent.id)
		expect(row.tools).toEqual({ mcpServers: {} })
		expect(row.llmConfig).toEqual({ model: 'original-model' })
	})

	it('PATCH lets a plain member change the system prompt and description of the shared agent', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				system_prompt: 'retuned prompt',
				description: 'retuned description',
			}),
		)

		expect(res.status).toBe(200)
		const row = await readAgent(agent.id)
		expect(row.systemPrompt).toBe('retuned prompt')
		expect(row.description).toBe('retuned description')
	})

	it('PATCH lets an admin of the shared workspace change tools and llm_config', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'admin')

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				tools: fakeTools,
				llm_config: { model: 'changed-model' },
			}),
		)

		expect(res.status).toBe(200)
		const row = await readAgent(agent.id)
		expect(row.tools).toMatchObject(fakeTools)
		expect(row.llmConfig).toEqual({ model: 'changed-model' })
	})

	it('PATCH refuses when the caller is admin in one workspace and only a member in the one the agent is in', async () => {
		const app = createApp()
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const { agent } = await seedAgentInWorkspaceOf(otherOwner.id, 'member')
		await insertWorkspace(db, getTestActorId()) // caller owns an unrelated workspace

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { tools: fakeTools }),
		)

		expect(res.status).toBe(403)
		expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {} })
	})

	describe('tools.envFrom needs a human admin or owner', () => {
		const storedEnvFrom = ['AGENT_SECRET_FAKE_STORED']

		/** An app where the caller is the given agent, as with an agent API key. */
		function createAgentCallerApp(agentId: string) {
			const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
			app.use('*', async (c, next) => {
				c.set('db', db)
				c.set('actorId', agentId)
				c.set('actorType', 'agent')
				c.set('sessionManager', { stopSession: async () => {} })
				await next()
			})
			app.route('/api/actors', actorsRoutes as never)
			return app
		}

		async function seedAgentWithEnvFrom(callerRole?: 'member' | 'admin') {
			const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
			const { ws, agent } = await seedAgentInWorkspaceOf(otherOwner.id, callerRole)
			await db
				.update(actors)
				.set({ tools: { mcpServers: {}, envFrom: storedEnvFrom } })
				.where(eq(actors.id, agent.id))
			return { ws, agent }
		}

		it('returns 403 and leaves the row unchanged when an agent adds a name to its own tools', async () => {
			const { agent } = await seedAgentWithEnvFrom()
			const res = await createAgentCallerApp(agent.id).request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { mcpServers: {}, envFrom: [...storedEnvFrom, 'AGENT_SECRET_FAKE_ADDED'] },
				}),
			)

			expect(res.status).toBe(403)
			expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {}, envFrom: storedEnvFrom })
		})

		it('returns 403 when an agent with no stored envFrom adds one to its own tools', async () => {
			const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
			const { agent } = await seedAgentInWorkspaceOf(otherOwner.id)

			const res = await createAgentCallerApp(agent.id).request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { mcpServers: {}, envFrom: ['AGENT_SECRET_FAKE_ADDED'] },
				}),
			)

			expect(res.status).toBe(403)
			expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {} })
		})

		it('returns 403 when an agent with the admin role changes envFrom on another agent', async () => {
			const { ws, agent } = await seedAgentWithEnvFrom()
			const adminAgent = await insertActor(db, { type: 'agent', name: 'Admin Agent' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: adminAgent.id, role: 'admin' })

			const res = await createAgentCallerApp(adminAgent.id).request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { mcpServers: {}, envFrom: ['AGENT_SECRET_FAKE_ADDED'] },
				}),
			)

			expect(res.status).toBe(403)
			expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {}, envFrom: storedEnvFrom })
		})

		it('lets an agent edit its other tools while envFrom stays as stored', async () => {
			const { agent } = await seedAgentWithEnvFrom()

			const res = await createAgentCallerApp(agent.id).request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { ...fakeTools, envFrom: storedEnvFrom },
				}),
			)

			expect(res.status).toBe(200)
			expect((await readAgent(agent.id)).tools).toMatchObject({
				...fakeTools,
				envFrom: storedEnvFrom,
			})
		})

		it('returns 403 when a plain human member changes envFrom', async () => {
			const { agent } = await seedAgentWithEnvFrom('member')

			const res = await createApp().request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { mcpServers: {}, envFrom: ['AGENT_SECRET_FAKE_ADDED'] },
				}),
			)

			expect(res.status).toBe(403)
			expect((await readAgent(agent.id)).tools).toEqual({ mcpServers: {}, envFrom: storedEnvFrom })
		})

		it('lets a human admin change envFrom', async () => {
			const { agent } = await seedAgentWithEnvFrom('admin')

			const res = await createApp().request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, {
					tools: { mcpServers: {}, envFrom: ['AGENT_SECRET_FAKE_ADDED'] },
				}),
			)

			expect(res.status).toBe(200)
			expect((await readAgent(agent.id)).tools).toMatchObject({
				envFrom: ['AGENT_SECRET_FAKE_ADDED'],
			})
		})
	})
})

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {},
	}
}

describe('Actors Integration — DELETE', () => {
	let workspaceId: string
	let agentId: string
	let storage: StorageProvider

	afterAll(() => {
		setTestAgentStorage(undefined)
	})

	beforeEach(async () => {
		storage = createMemoryStorage()
		setTestAgentStorage(new AgentStorageManager(storage, db))
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Delete Me' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: agentId,
			role: 'member',
		})
	})

	it('cleans up subscriptions, read_state, sessions, and authored artifacts', async () => {
		const app = createApp()
		const humanId = getTestActorId()

		// Per-actor feed bookkeeping rows that previously blocked the delete.
		await db.insert(subscriptions).values(buildSubscription({ workspaceId, actorId: agentId }))
		await db.insert(readState).values(buildReadState({ workspaceId, actorId: agentId }))

		// A session this agent created for another actor — exercises the
		// sessions.created_by reassignment branch.
		const createdSession = await insertSession(db, workspaceId, humanId, agentId)

		// A session the agent ran itself — deleted along with the actor.
		const ownSession = await insertSession(db, workspaceId, agentId, humanId)

		// A notification sent to the human about the agent's own session. Its
		// source/target actor is the human, not the agent, so the agent-scoped
		// notification cleanup won't touch it — but it still references
		// ownSession via session_id, which is about to be hard-deleted. Without
		// ON DELETE SET NULL on notifications.session_id, this FK reference
		// blocks the session delete with a 23503 violation.
		const notification = await insertNotification(db, workspaceId, humanId, {
			targetActorId: humanId,
			sessionId: ownSession.id,
		})

		// A file the agent pushed back to storage while running its own session
		// (e.g. an updated memory/learnings file) — this is how every completed
		// session's agent_files row ends up referencing sessions.id. It's owned
		// by the same agent that's about to be deleted, so it's cleaned up by
		// the agent-scoped agent_files delete below — but only after the agent's
		// own sessions are deleted first. Without ON DELETE SET NULL on
		// agent_files.session_id, that ordering blocks the session delete with a
		// 23503 violation.
		const [agentFile] = await db
			.insert(agentFiles)
			.values(buildAgentFile({ workspaceId, actorId: agentId, sessionId: ownSession.id }))
			.returning()

		// Workspace artifacts authored by the agent.
		const [wsSkill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId, createdBy: agentId }))
			.returning()
		const [fileRow] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: agentId }))
			.returning()
		const [importRow] = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: agentId }))
			.returning()

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })

		// Actor is gone.
		const remainingActor = await db.select().from(actors).where(eq(actors.id, agentId))
		expect(remainingActor).toHaveLength(0)

		// Subscriptions and read_state for the agent are gone.
		const remainingSubs = await db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.actorId, agentId))
		expect(remainingSubs).toHaveLength(0)
		const remainingReads = await db.select().from(readState).where(eq(readState.actorId, agentId))
		expect(remainingReads).toHaveLength(0)

		// The agent's own session is deleted.
		const ownSessionAfter = await db.select().from(sessions).where(eq(sessions.id, ownSession.id))
		expect(ownSessionAfter).toHaveLength(0)

		// The human's notification about that session survives (it isn't owned
		// by the deleted agent) but its session_id is nulled rather than
		// blocking the session delete with a FK violation.
		const [notificationAfter] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, notification.id))
		expect(notificationAfter).toBeDefined()
		expect(notificationAfter.sessionId).toBeNull()

		// The agent's own file record is gone (agent-scoped agent_files cleanup),
		// which only runs because the session delete above no longer blocks on
		// this row's session_id FK.
		const remainingAgentFiles = await db
			.select()
			.from(agentFiles)
			.where(eq(agentFiles.id, agentFile.id))
		expect(remainingAgentFiles).toHaveLength(0)

		// The session the agent created for the human is reassigned, not deleted.
		const [createdSessionAfter] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, createdSession.id))
		expect(createdSessionAfter).toBeDefined()
		expect(createdSessionAfter.createdBy).toBe(humanId)

		// Workspace skills: createdBy is nulled.
		const [skillAfter] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, wsSkill.id))
		expect(skillAfter.createdBy).toBeNull()

		// Files and imports: createdBy is reassigned to the deleting actor.
		const [fileAfter] = await db.select().from(files).where(eq(files.id, fileRow.id))
		expect(fileAfter.createdBy).toBe(humanId)
		const [importAfter] = await db.select().from(imports).where(eq(imports.id, importRow.id))
		expect(importAfter.createdBy).toBe(humanId)
	})

	it('stores only identity fields in the deleted event, no tools, llm_config or credentials', async () => {
		const app = createApp()
		await db
			.update(actors)
			.set({
				apiKey: 'fake-api-key-for-test',
				systemPrompt: 'fake system prompt for test',
				tools: { mcpServers: { fake: { env: { FAKE_TOKEN: 'fake-env-secret-for-test' } } } },
				llmConfig: { api_key: 'fake-llm-key-for-test' },
				memory: { notes: 'fake memory for test' },
			})
			.where(eq(actors.id, agentId))

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)

		const rows = await db.select().from(events).where(eq(events.entityId, agentId))
		const deleted = rows.filter((r) => r.action === 'deleted')
		expect(deleted).toHaveLength(1)
		expect(deleted[0].data).toEqual({
			id: agentId,
			type: 'agent',
			name: 'Delete Me',
			is_system: false,
		})
		expect(JSON.stringify(rows)).not.toMatch(/fake-/)

		// The events read routes return the stored row as is, so check what
		// they actually serve: history, and the SSE replay path.
		const historyRes = await createIntegrationApp({
			path: '/api/events',
			module: eventsRoutes,
		}).request(
			jsonGet(`/api/events/history?entity_id=${agentId}`, { 'x-workspace-id': workspaceId }),
		)
		expect(historyRes.status).toBe(200)
		const historyText = await historyRes.text()
		expect(historyText).toContain('Delete Me')
		expect(historyText).not.toMatch(/fake-/)

		const sseApp = new OpenAPIHono()
		sseApp.use('*', async (c, next) => {
			c.set('db' as never, db as never)
			c.set('actorId' as never, getTestActorId() as never)
			c.set('notifyBridge' as never, { on() {}, off() {} } as never)
			await next()
		})
		sseApp.route('/api/events', eventsRoutes as never)
		const abort = new AbortController()
		const sseRes = await sseApp.request('/api/events', {
			headers: { 'x-workspace-id': workspaceId, 'last-event-id': '0' },
			signal: abort.signal,
		})
		expect(sseRes.status).toBe(200)
		const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader()
		const decoder = new TextDecoder()
		let sseText = ''
		while (!sseText.includes('Delete Me')) {
			const { value, done } = await reader.read()
			if (done) break
			sseText += decoder.decode(value)
		}
		abort.abort()
		await reader.cancel().catch(() => {})
		expect(sseText).toContain('Delete Me')
		expect(sseText).not.toMatch(/fake-/)
	})

	it('removes every storage object under the deleted agent and leaves other agents untouched', async () => {
		const app = createApp()
		const body = Buffer.from('fake memory')
		const own = [
			`agents/${workspaceId}/${agentId}/memory/CLAUDE.md`,
			`agents/${workspaceId}/${agentId}/learnings/session-1.md`,
			`agents/${workspaceId}/${agentId}/skills/s/SKILL.md`,
		]
		// Keys that must survive: another agent in the same workspace, the same
		// id in another workspace, and an id that merely starts with this one.
		const otherAgentId = randomUUID()
		const otherWorkspaceId = randomUUID()
		const survivors = [
			`agents/${workspaceId}/${otherAgentId}/memory/CLAUDE.md`,
			`agents/${otherWorkspaceId}/${agentId}/memory/CLAUDE.md`,
			`agents/${workspaceId}/${agentId}-extra/memory/CLAUDE.md`,
		]
		for (const key of [...own, ...survivors]) await storage.put(key, body)

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)

		expect(await storage.list(`agents/${workspaceId}/${agentId}/`)).toEqual([])
		for (const key of own) expect(await storage.exists(key)).toBe(false)
		for (const key of survivors) expect(await storage.exists(key)).toBe(true)
	})

	it('returns 500 and keeps the agent when a storage object cannot be deleted', async () => {
		const app = createApp()
		const failingKey = `agents/${workspaceId}/${agentId}/memory/CLAUDE.md`
		const otherKey = `agents/${workspaceId}/${agentId}/learnings/session-1.md`
		await storage.put(failingKey, Buffer.from('fake memory'))
		await storage.put(otherKey, Buffer.from('fake learning'))
		const realDelete = storage.delete.bind(storage)
		storage.delete = async (key: string) => {
			if (key === failingKey) throw new Error('s3 unavailable')
			await realDelete(key)
		}

		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${agentId}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(500)
		expect((await res.json()).deleted).toBeUndefined()

		// The agent is still there so the delete can be retried, and no
		// deleted event was recorded.
		const remaining = await db.select().from(actors).where(eq(actors.id, agentId))
		expect(remaining).toHaveLength(1)
		const rows = await db.select().from(events).where(eq(events.entityId, agentId))
		expect(rows.filter((r) => r.action === 'deleted')).toHaveLength(0)
		// Every other key was still attempted, the failing one remains.
		expect(await storage.exists(failingKey)).toBe(true)
		expect(await storage.exists(otherKey)).toBe(false)
	})
})

// An agent is created by an authenticated caller and born as a member of the
// workspace named in the request body, in one transaction. This replaces the old
// two-step create-then-add-member sequence, whose second step is human-admin-only
// and left agents created by an agent or a plain member outside the workspace.
describe('Actors Integration — POST /api/actors agent creation', () => {
	// The integration test actor (a human) is seeded with this key.
	const TEST_ACTOR_KEY = 'ank_testintegration'
	const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

	/** A workspace owned by someone else, with the test actor in it at `role`. */
	async function workspaceWithTestActor(role: 'admin' | 'member') {
		const owner = await insertActor(db, { type: 'human', name: 'Workspace Owner' })
		const ws = await insertWorkspace(db, owner.id)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: getTestActorId(), role })
		return ws
	}

	async function agentRowsNamed(name: string) {
		return db.select().from(actors).where(eq(actors.name, name))
	}

	async function membershipRows(actorId: string) {
		return db.select().from(workspaceMembers).where(eq(workspaceMembers.actorId, actorId))
	}

	function post(body: Record<string, unknown>, headers: Record<string, string>) {
		return createApp().request(
			jsonRequest('POST', '/api/actors', { type: 'agent', ...body }, headers),
		)
	}

	it('lets a plain human member create an agent that is born a member, and lists it', async () => {
		const ws = await workspaceWithTestActor('member')
		const name = `Born member ${randomUUID()}`

		const res = await post(
			{ name, workspace_id: ws.id, system_prompt: 'You are a test agent', description: 'Test' },
			bearer(TEST_ACTOR_KEY),
		)

		expect(res.status).toBe(201)
		const created = await res.json()
		expect(created.type).toBe('agent')
		expect(created.workspace_id).toBe(ws.id)
		expect(created.api_key).toMatch(/^ank_/)

		const [row] = await agentRowsNamed(name)
		expect(row.createdBy).toBe(getTestActorId())
		const memberships = await membershipRows(created.id)
		expect(memberships).toHaveLength(1)
		expect(memberships[0]).toMatchObject({ workspaceId: ws.id, role: 'member' })

		// Same query list_actors reads: the new agent shows up as a member.
		const listRes = await createApp().request(jsonGet('/api/actors', { 'x-workspace-id': ws.id }))
		const members = (await listRes.json()) as Array<{ id: string; role: string }>
		expect(members.find((m) => m.id === created.id)?.role).toBe('member')

		const [event] = await db.select().from(events).where(eq(events.entityId, created.id))
		expect(event).toMatchObject({
			workspaceId: ws.id,
			actorId: getTestActorId(),
			action: 'created',
			entityType: 'workspace_member',
		})
	})

	it('lets an agent caller create an agent', async () => {
		const ws = await workspaceWithTestActor('member')
		const callerKey = `ank_agentcaller${randomUUID()}`
		const caller = await insertActor(db, { type: 'agent', name: 'Caller Agent', apiKey: callerKey })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: caller.id, role: 'member' })
		const name = `Born of agent ${randomUUID()}`

		const res = await post({ name, workspace_id: ws.id }, bearer(callerKey))

		expect(res.status).toBe(201)
		const created = await res.json()
		const [row] = await agentRowsNamed(name)
		expect(row.createdBy).toBe(caller.id)
		expect(await membershipRows(created.id)).toHaveLength(1)
	})

	it('returns 404 and writes no rows when the caller is not a member of the named workspace', async () => {
		const mine = await workspaceWithTestActor('member')
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const theirs = await insertWorkspace(db, otherOwner.id)
		const name = `Cross workspace ${randomUUID()}`

		// The header names a workspace the caller belongs to; only the body counts.
		const res = await post(
			{ name, workspace_id: theirs.id },
			{ ...bearer(TEST_ACTOR_KEY), 'x-workspace-id': mine.id },
		)

		expect(res.status).toBe(404)
		expect(await agentRowsNamed(name)).toHaveLength(0)
		const theirMembers = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, theirs.id))
		expect(theirMembers).toHaveLength(1)
	})

	it('returns 401 and writes no rows with no key or an invalid key', async () => {
		const ws = await workspaceWithTestActor('member')
		const name = `Unauthenticated ${randomUUID()}`

		const noKey = await post({ name, workspace_id: ws.id }, {})
		const badKey = await post({ name, workspace_id: ws.id }, bearer('ank_doesnotexist'))

		expect(noKey.status).toBe(401)
		expect(badKey.status).toBe(401)
		expect(await agentRowsNamed(name)).toHaveLength(0)
	})

	it('returns 400 when an agent names no workspace', async () => {
		const name = `No workspace ${randomUUID()}`

		const res = await post({ name }, bearer(TEST_ACTOR_KEY))

		expect(res.status).toBe(400)
		expect(await agentRowsNamed(name)).toHaveLength(0)
	})

	it('returns 409 and leaves the existing agent alone when the supplied id is taken', async () => {
		const ws = await workspaceWithTestActor('member')
		const existing = await insertActor(db, { type: 'agent', name: 'Existing Agent' })

		const res = await post(
			{ name: 'Clone', id: existing.id, workspace_id: ws.id },
			bearer(TEST_ACTOR_KEY),
		)

		expect(res.status).toBe(409)
		expect(await membershipRows(existing.id)).toHaveLength(0)
	})

	describe('tools and llm_config need a human admin or owner', () => {
		const fakeTools = {
			mcpServers: { fake: { type: 'http', url: 'https://fake.invalid/mcp', headers: {} } },
		}

		it.each([
			['tools', { tools: fakeTools }],
			['llm_config', { llm_config: { model: 'fake-model' } }],
		])('returns 403 and writes no rows when a human member sends %s', async (_field, extra) => {
			const ws = await workspaceWithTestActor('member')
			const name = `Member with config ${randomUUID()}`

			const res = await post({ name, workspace_id: ws.id, ...extra }, bearer(TEST_ACTOR_KEY))

			expect(res.status).toBe(403)
			expect(await agentRowsNamed(name)).toHaveLength(0)
		})

		it('returns 403 and writes no rows when an agent caller with the admin role sends tools', async () => {
			const ws = await workspaceWithTestActor('member')
			const callerKey = `ank_adminagent${randomUUID()}`
			const caller = await insertActor(db, {
				type: 'agent',
				name: 'Admin Agent',
				apiKey: callerKey,
			})
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: caller.id, role: 'admin' })
			const name = `Agent admin with tools ${randomUUID()}`

			const res = await post({ name, workspace_id: ws.id, tools: fakeTools }, bearer(callerKey))

			expect(res.status).toBe(403)
			expect(await agentRowsNamed(name)).toHaveLength(0)
		})

		it('returns 403 and writes no rows when an agent caller with the admin role sends envFrom', async () => {
			const ws = await workspaceWithTestActor('member')
			const callerKey = `ank_envfromagent${randomUUID()}`
			const caller = await insertActor(db, {
				type: 'agent',
				name: 'Env Admin Agent',
				apiKey: callerKey,
			})
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: caller.id, role: 'admin' })
			const name = `Agent admin with envFrom ${randomUUID()}`

			const res = await post(
				{ name, workspace_id: ws.id, tools: { envFrom: ['AGENT_SECRET_FAKE_NAME'] } },
				bearer(callerKey),
			)

			expect(res.status).toBe(403)
			expect(await agentRowsNamed(name)).toHaveLength(0)
		})

		it('lets a human admin set tools and llm_config, merged over the Maskin MCP', async () => {
			const ws = await workspaceWithTestActor('admin')
			const name = `Admin with config ${randomUUID()}`

			const res = await post(
				{ name, workspace_id: ws.id, tools: fakeTools, llm_config: { model: 'fake-model' } },
				bearer(TEST_ACTOR_KEY),
			)

			expect(res.status).toBe(201)
			const [row] = await agentRowsNamed(name)
			const mcpServers = (row.tools as { mcpServers: Record<string, unknown> }).mcpServers
			expect(Object.keys(mcpServers).sort()).toEqual(['fake', 'maskin'])
			expect(row.llmConfig).toEqual({ model: 'fake-model' })
		})

		it('gives a member who sends only name, description and prompt the Maskin MCP alone', async () => {
			const ws = await workspaceWithTestActor('member')
			const name = `Member plain ${randomUUID()}`

			const res = await post(
				{ name, workspace_id: ws.id, description: 'Test', system_prompt: 'You are a test agent' },
				bearer(TEST_ACTOR_KEY),
			)

			expect(res.status).toBe(201)
			const [row] = await agentRowsNamed(name)
			expect(Object.keys((row.tools as { mcpServers: object }).mcpServers)).toEqual(['maskin'])
		})
	})

	it('rejects workspace_id on a human signup', async () => {
		const ws = await workspaceWithTestActor('member')

		const res = await createApp().request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Human With Workspace',
				email: `human-ws-${randomUUID()}@example.com`,
				password: 'correct-horse-battery',
				workspace_id: ws.id,
			}),
		)

		expect(res.status).toBe(400)
	})
})

describe('Actors Integration — signup workspace provisioning', () => {
	// Signup used to seed only Workspace Coach in-transaction and leave the rest
	// of the roster to a post-commit call, so a signed-up workspace was furnished
	// differently from one created via POST /api/workspaces. Both now share
	// provisionWorkspace(), so the auto-created workspace must come out with the
	// full default agent roster and a pinned default chat agent.
	const DEFAULT_AGENT_NAMES = [
		'Chief of Staff',
		'Driver',
		'Knowledge Curator',
		'Researcher',
		'Signal Analyst',
		'Strategist',
		'Workspace Coach',
	]

	it('auto-creates a workspace seeded with the full default agent roster', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Provisioned Human',
				email: `provisioned-${randomUUID()}@example.com`,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.workspace_id).toBeTruthy()

		const memberNames = await db
			.select({ name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(eq(workspaceMembers.workspaceId, body.workspace_id))

		const agentNames = memberNames
			.map((r) => r.name)
			.filter((n) => DEFAULT_AGENT_NAMES.includes(n))
			.sort()
		expect(agentNames).toEqual(DEFAULT_AGENT_NAMES)
	})

	it('does not return the stored passwordHash in the signup response', async () => {
		const app = createApp()
		const email = `no-hash-${randomUUID()}@example.com`

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'No Hash Human',
				email,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body).not.toHaveProperty('passwordHash')
		expect(JSON.stringify(body)).not.toContain('$2')

		// Guard against a vacuous pass: the hash really was stored for this actor.
		const [row] = await db
			.select({ passwordHash: actors.passwordHash })
			.from(actors)
			.where(eq(actors.id, body.id))
			.limit(1)
		expect(row?.passwordHash).toBeTruthy()
		expect(JSON.stringify(body)).not.toContain(row?.passwordHash as string)
	})

	it('pins Chief of Staff as the auto-created workspace default chat agent', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Pinned Default',
				email: `pinned-${randomUUID()}@example.com`,
				password: 'correct-horse-battery',
			}),
		)
		expect(res.status).toBe(201)
		const { workspace_id: workspaceId } = await res.json()

		const [ws] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)

		const defaultAgentId = (ws?.settings as { default_agent_id?: string } | null)?.default_agent_id
		expect(defaultAgentId).toBeTruthy()

		const [chief] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, defaultAgentId as string))
			.limit(1)
		expect(chief?.name).toBe('Chief of Staff')
	})
})

describe('Actors Integration — GET voice_enabled projection', () => {
	// A read-time smoke check that the projection lives on every read path a
	// UI consumer touches: list, get, and pause/run's returning clause.
	it('GET /:id projects voice_enabled from metadata', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Voicey Read' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true } })
			.where(eq(actors.id, agent.id))

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': ws.id }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.voice_enabled).toBe(true)
	})

	it('GET /:id returns false when metadata is null or missing the key', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Voiceless' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`, { 'x-workspace-id': ws.id }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.voice_enabled).toBe(false)
	})

	it('GET /api/actors workspace-scoped list projects voice_enabled per row', async () => {
		const app = createApp()
		const admin = getTestActorId()
		const ws = await insertWorkspace(db, admin)
		const on = await insertActor(db, { type: 'agent', name: 'On' })
		const off = await insertActor(db, { type: 'agent', name: 'Off' })
		await db.insert(workspaceMembers).values([
			{ workspaceId: ws.id, actorId: on.id, role: 'member' },
			{ workspaceId: ws.id, actorId: off.id, role: 'member' },
		])
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true } })
			.where(eq(actors.id, on.id))

		const res = await app.request(jsonGet('/api/actors', { 'x-workspace-id': ws.id }))
		expect(res.status).toBe(200)
		const body = await res.json()
		const rowFor = (name: string) => body.find((r: { name: string }) => r.name === name)
		expect(rowFor('On')?.voice_enabled).toBe(true)
		expect(rowFor('Off')?.voice_enabled).toBe(false)
	})
})
