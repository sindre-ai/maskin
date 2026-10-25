import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, conversations, sessions, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { MASKED_VALUE } from '../../lib/actor-tools-redaction'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: sessionsRoutes } = await import('../../routes/sessions')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: SessionManager }
}

// Obviously fake values only; the real thing never appears in a test.
const FAKE_LLM_KEY = 'not-a-real-key'
const FAKE_LLM_KEY_ROTATED = 'not-a-real-key-rotated'
const FAKE_ENV_VAR = 'not-a-real-env-var-value'
const FAKE_MCP_ENV = 'not-a-real-mcp-env-value'
const FAKE_MCP_HEADER = 'Bearer not-a-real-mcp-header-value'

type StoredSessionConfig = ReturnType<typeof buildStoredSessionConfig>

function buildStoredSessionConfig() {
	return {
		runtime: 'claude-code',
		env_vars: { FAKE_TOKEN: FAKE_ENV_VAR },
		mcps: [
			{
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp-server'],
				env: { FAKE_KEY: FAKE_MCP_ENV },
			},
			{
				type: 'http',
				url: 'https://mcp.example.test/mcp',
				headers: { Authorization: FAKE_MCP_HEADER },
			},
		],
	}
}

/** The actors and sessions routes mounted with the request authenticated as the test owner. */
function createApp() {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('sessionManager', {} as unknown as SessionManager)
		await next()
	})
	app.route('/api/actors', actorsRoutes as unknown as OpenAPIHono<Env>)
	app.route('/api/sessions', sessionsRoutes as unknown as OpenAPIHono<Env>)
	return app
}

async function storedLlmConfig(id: string) {
	const [row] = await db
		.select({ llmConfig: actors.llmConfig })
		.from(actors)
		.where(eq(actors.id, id))
	return row.llmConfig
}

async function addMember(workspaceId: string, actorId: string) {
	await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
}

/** A workspace owned by the test actor, holding an agent whose llm_config stores a fake api key. */
async function seedAgentWithApiKey() {
	const ws = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Keyed Agent',
		llmProvider: 'openai',
		llmConfig: { api_key: FAKE_LLM_KEY, model: 'fake-model' },
	})
	await addMember(ws.id, agent.id)
	return { ws, agent }
}

describe('Actor llm_config redaction — GET /api/actors/:id', () => {
	it('never returns the stored api_key, and shows the key is set', async () => {
		const { agent } = await seedAgentWithApiKey()

		const res = await createApp().request(jsonGet(`/api/actors/${agent.id}`))

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_LLM_KEY)
		expect(JSON.parse(text).llm_config).toEqual({ api_key: MASKED_VALUE, model: 'fake-model' })
	})

	it('masks the camelCase spelling too', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Camel Agent',
			llmConfig: { apiKey: FAKE_LLM_KEY },
		})
		await addMember(ws.id, agent.id)

		const res = await createApp().request(jsonGet(`/api/actors/${agent.id}`))

		const text = await res.text()
		expect(text).not.toContain(FAKE_LLM_KEY)
		expect(JSON.parse(text).llm_config).toEqual({ apiKey: MASKED_VALUE })
	})

	it('masks the key for the actor itself too', async () => {
		const { agent } = await seedAgentWithApiKey()
		const app = new OpenAPIHono<Env>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', agent.id)
			c.set('actorType', 'agent')
			c.set('sessionManager', {} as unknown as SessionManager)
			await next()
		})
		app.route('/api/actors', actorsRoutes as unknown as OpenAPIHono<Env>)

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))

		expect(await res.text()).not.toContain(FAKE_LLM_KEY)
	})
})

describe('Actor llm_config redaction — PATCH /api/actors/:id', () => {
	it('keeps the stored key when a masked llm_config is sent back, and never returns it', async () => {
		const { agent } = await seedAgentWithApiKey()
		const app = createApp()

		const read = await (await app.request(jsonGet(`/api/actors/${agent.id}`))).json()
		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				llm_config: { ...read.llm_config, model: 'fake-model-2' },
			}),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_LLM_KEY)
		expect(JSON.parse(text).llm_config).toEqual({ api_key: MASKED_VALUE, model: 'fake-model-2' })
		expect(await storedLlmConfig(agent.id)).toEqual({
			api_key: FAKE_LLM_KEY,
			model: 'fake-model-2',
		})
	})

	it('saves a real new key, stores it raw and returns it masked', async () => {
		const { agent } = await seedAgentWithApiKey()

		const res = await createApp().request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, {
				llm_config: { api_key: FAKE_LLM_KEY_ROTATED, model: 'fake-model' },
			}),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_LLM_KEY_ROTATED)
		expect(JSON.parse(text).llm_config.api_key).toBe(MASKED_VALUE)
		expect(await storedLlmConfig(agent.id)).toEqual({
			api_key: FAKE_LLM_KEY_ROTATED,
			model: 'fake-model',
		})
	})

	it('rejects a masked key when nothing is stored, and writes nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Unkeyed Agent', llmConfig: null })
		await addMember(ws.id, agent.id)

		const res = await createApp().request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { llm_config: { api_key: MASKED_VALUE } }),
		)

		expect(res.status).toBe(400)
		expect(await storedLlmConfig(agent.id)).toBeNull()
	})

	it('masks the key in the pause response too', async () => {
		const { ws, agent } = await seedAgentWithApiKey()

		const res = await createApp().request(
			jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_LLM_KEY)
		expect(JSON.parse(text).llm_config.api_key).toBe(MASKED_VALUE)
	})
})

describe('Session config redaction — sessions routes', () => {
	async function seedSessionWithSecrets() {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Session Agent' })
		const session = await insertSession(db, ws.id, agent.id, getTestActorId(), {
			config: buildStoredSessionConfig(),
		})
		return { ws, session }
	}

	function expectRedacted(text: string, config: StoredSessionConfig) {
		expect(text).not.toContain(FAKE_ENV_VAR)
		expect(text).not.toContain(FAKE_MCP_ENV)
		expect(text).not.toContain(FAKE_MCP_HEADER)
		expect(config.env_vars).toEqual({ FAKE_TOKEN: MASKED_VALUE })
		expect(config.mcps[0].env).toEqual({ FAKE_KEY: MASKED_VALUE })
		expect(config.mcps[1].headers).toEqual({ Authorization: MASKED_VALUE })
		expect(config.mcps[1].url).toBe('https://mcp.example.test/mcp')
		expect(config.runtime).toBe('claude-code')
	}

	it('masks the secrets in GET /api/sessions/:id', async () => {
		const { ws, session } = await seedSessionWithSecrets()

		const res = await createApp().request(
			jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expectRedacted(text, JSON.parse(text).config)
	})

	it('masks the secrets in GET /api/sessions with verbose=true', async () => {
		const { ws, session } = await seedSessionWithSecrets()

		const res = await createApp().request(
			jsonGet('/api/sessions?verbose=true', { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		const row = (JSON.parse(text) as { id: string; config: StoredSessionConfig }[]).find(
			(r) => r.id === session.id,
		)
		expect(row).toBeDefined()
		expectRedacted(text, row?.config as StoredSessionConfig)
	})

	it('masks the secrets in GET /api/sessions with verbose=true and a conversation_id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent', name: 'Chat Agent' })
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId: ws.id, title: 'New chat', createdBy: getTestActorId() })
			.returning()
		const session = await insertSession(db, ws.id, agent.id, getTestActorId(), {
			config: buildStoredSessionConfig(),
			conversationId: conversation.id,
		})

		const res = await createApp().request(
			jsonGet(`/api/sessions?verbose=true&conversation_id=${conversation.id}`, {
				'x-workspace-id': ws.id,
			}),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		const row = (JSON.parse(text) as { id: string; config: StoredSessionConfig }[]).find(
			(r) => r.id === session.id,
		)
		expect(row).toBeDefined()
		expectRedacted(text, row?.config as StoredSessionConfig)
	})

	it('leaves the stored row holding the raw values', async () => {
		const { ws, session } = await seedSessionWithSecrets()
		const app = createApp()

		await app.request(jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': ws.id }))
		await app.request(jsonGet('/api/sessions?verbose=true', { 'x-workspace-id': ws.id }))

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row.config).toEqual(buildStoredSessionConfig())
	})
})
