import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { MASKED_VALUE } from '../../lib/actor-tools-redaction'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: SessionManager }
}

// Obviously fake values only; the real thing never appears in a test.
const FAKE_ENV_VALUE = 'fake-env-value-not-a-secret'
const FAKE_HEADER_VALUE = 'Bearer fake-header-value-not-a-secret'

function buildStoredTools() {
	return {
		mcpServers: {
			tracker: {
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp-server'],
				env: { FAKE_API_KEY: FAKE_ENV_VALUE },
			},
			docs: {
				type: 'http',
				url: 'https://mcp.example.test/mcp',
				headers: { Authorization: FAKE_HEADER_VALUE },
			},
		},
	}
}

/** The actors route mounted with the request authenticated as a specific actor. */
function createAppAs(actorId: string) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'agent')
		c.set('sessionManager', {
			stopSession: async () => {},
			pauseSession: async () => {},
		} as unknown as SessionManager)
		await next()
	})
	app.route('/api/actors', actorsRoutes as unknown as OpenAPIHono<Env>)
	return app
}

async function addMember(workspaceId: string, actorId: string, role: string) {
	await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
}

async function storedTools(id: string) {
	const [row] = await db.select({ tools: actors.tools }).from(actors).where(eq(actors.id, id))
	return row.tools
}

/** A workspace owned by the test actor, holding an agent with a stored secret config. */
async function seedWorkspaceWithConfiguredAgent() {
	const ws = await insertWorkspace(db, getTestActorId())
	const target = await insertActor(db, {
		type: 'agent',
		name: 'Configured Agent',
		tools: buildStoredTools(),
	})
	await addMember(ws.id, target.id, 'member')
	return { ws, target }
}

describe('Actor tool config redaction — GET /api/actors/:id', () => {
	it('masks env and header values for a workspace member who is not an admin', async () => {
		const { ws, target } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')

		const res = await createAppAs(peer.id).request(jsonGet(`/api/actors/${target.id}`))

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_ENV_VALUE)
		expect(text).not.toContain(FAKE_HEADER_VALUE)
		const body = JSON.parse(text)
		expect(body.tools.mcpServers.tracker.env).toEqual({ FAKE_API_KEY: MASKED_VALUE })
		expect(body.tools.mcpServers.docs.headers).toEqual({ Authorization: MASKED_VALUE })
		expect(body.tools.mcpServers.docs.url).toBe('https://mcp.example.test/mcp')
		expect(body.tools.mcpServers.tracker.command).toBe('npx')
	})

	it('shows real values to the actor itself', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()

		const res = await createAppAs(target.id).request(jsonGet(`/api/actors/${target.id}`))

		const body = await res.json()
		expect(body.tools.mcpServers.tracker.env.FAKE_API_KEY).toBe(FAKE_ENV_VALUE)
		expect(body.tools.mcpServers.docs.headers.Authorization).toBe(FAKE_HEADER_VALUE)
	})

	it('shows real values to an owner of a workspace the actor belongs to', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()

		const res = await createAppAs(getTestActorId()).request(jsonGet(`/api/actors/${target.id}`))

		const body = await res.json()
		expect(body.tools.mcpServers.tracker.env.FAKE_API_KEY).toBe(FAKE_ENV_VALUE)
	})

	it('shows real values to an admin of a workspace the actor belongs to', async () => {
		const { ws, target } = await seedWorkspaceWithConfiguredAgent()
		const admin = await insertActor(db, { type: 'agent', name: 'Admin Agent' })
		await addMember(ws.id, admin.id, 'admin')

		const res = await createAppAs(admin.id).request(jsonGet(`/api/actors/${target.id}`))

		const body = await res.json()
		expect(body.tools.mcpServers.docs.headers.Authorization).toBe(FAKE_HEADER_VALUE)
	})

	it('masks values for an admin of a different workspace the actor is not in', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()
		const outsider = await insertActor(db, { type: 'agent', name: 'Outsider Admin' })
		const otherWs = await insertWorkspace(db, outsider.id)
		expect(otherWs.id).toBeDefined()

		const res = await createAppAs(outsider.id).request(jsonGet(`/api/actors/${target.id}`))

		const text = await res.text()
		expect(text).not.toContain(FAKE_ENV_VALUE)
		expect(text).not.toContain(FAKE_HEADER_VALUE)
	})
})

describe('Actor tool config redaction — GET /api/actors (list)', () => {
	it('returns no tools config for any actor in the workspace-scoped list', async () => {
		const { ws } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')

		const res = await createAppAs(peer.id).request(
			jsonGet('/api/actors?limit=50', { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_ENV_VALUE)
		expect(text).not.toContain(FAKE_HEADER_VALUE)
		const rows = JSON.parse(text) as Record<string, unknown>[]
		expect(rows.length).toBeGreaterThan(1)
		for (const row of rows) expect(row).not.toHaveProperty('tools')
	})

	it('returns no tools config in the cross-workspace list or the unpaginated list', async () => {
		const { ws } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')
		const app = createAppAs(peer.id)

		for (const req of [
			jsonGet('/api/actors'),
			jsonGet('/api/actors', { 'x-workspace-id': ws.id }),
			jsonGet('/api/actors?limit=50'),
		]) {
			const text = await (await app.request(req)).text()
			expect(text).not.toContain(FAKE_ENV_VALUE)
			expect(text).not.toContain(FAKE_HEADER_VALUE)
		}
	})
})

describe('Actor tool config redaction — PATCH /api/actors/:id', () => {
	it('rejects a peer sending a masked config with an extra env key and leaves the stored secrets untouched', async () => {
		const { ws, target } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')
		const app = createAppAs(peer.id)

		const read = await (await app.request(jsonGet(`/api/actors/${target.id}`))).json()
		read.tools.mcpServers.tracker.env.NODE_OPTIONS = '--require=/tmp/fake.js'
		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				description: 'edited by a peer',
				tools: read.tools,
			}),
		)

		expect(res.status).toBe(403)
		expect(await res.text()).not.toContain(FAKE_ENV_VALUE)
		expect(await storedTools(target.id)).toEqual(buildStoredTools())
	})

	it('keeps stored secrets when an admin round-trips a masked config', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()
		const masked = {
			mcpServers: {
				tracker: { ...buildStoredTools().mcpServers.tracker, env: { FAKE_API_KEY: MASKED_VALUE } },
				docs: { ...buildStoredTools().mcpServers.docs, headers: { Authorization: MASKED_VALUE } },
			},
		}

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { name: 'Renamed', tools: masked }),
		)

		expect(res.status).toBe(200)
		expect(await storedTools(target.id)).toEqual(buildStoredTools())
	})

	it('still saves a real new value and keeps the masked neighbours', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()
		const tools = {
			mcpServers: {
				tracker: {
					...buildStoredTools().mcpServers.tracker,
					env: { FAKE_API_KEY: 'fake-rotated' },
				},
				docs: { ...buildStoredTools().mcpServers.docs, headers: { Authorization: MASKED_VALUE } },
			},
		}

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { tools }),
		)

		expect(res.status).toBe(200)
		const stored = (await storedTools(target.id)) as ReturnType<typeof buildStoredTools>
		expect(stored.mcpServers.tracker.env.FAKE_API_KEY).toBe('fake-rotated')
		expect(stored.mcpServers.docs.headers.Authorization).toBe(FAKE_HEADER_VALUE)
	})

	it('rejects a masked value pointed at a changed url and leaves the stored config untouched', async () => {
		const { target } = await seedWorkspaceWithConfiguredAgent()
		const masked = {
			mcpServers: {
				tracker: { ...buildStoredTools().mcpServers.tracker, env: { FAKE_API_KEY: MASKED_VALUE } },
				docs: {
					...buildStoredTools().mcpServers.docs,
					url: 'https://attacker.example.test/mcp',
					headers: { Authorization: MASKED_VALUE },
				},
			},
		}

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { tools: masked }),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(FAKE_HEADER_VALUE)
		expect(await storedTools(target.id)).toEqual(buildStoredTools())
	})

	it('masks the tools config in the response for a non-admin caller', async () => {
		const { ws, target } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')

		const res = await createAppAs(peer.id).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { description: 'no tools in body' }),
		)

		const text = await res.text()
		expect(text).not.toContain(FAKE_ENV_VALUE)
		expect(JSON.parse(text).tools.mcpServers.tracker.env).toEqual({ FAKE_API_KEY: MASKED_VALUE })
		expect(await storedTools(target.id)).toEqual(buildStoredTools())
	})
})

describe('Actor tool config redaction — POST /api/actors/:id/pause', () => {
	it('masks the tools config in the response for a non-admin caller', async () => {
		const { ws, target } = await seedWorkspaceWithConfiguredAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')

		const res = await createAppAs(peer.id).request(
			jsonRequest('POST', `/api/actors/${target.id}/pause`, undefined, { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_ENV_VALUE)
		expect(text).not.toContain(FAKE_HEADER_VALUE)
		expect(JSON.parse(text).tools.mcpServers.docs.headers).toEqual({ Authorization: MASKED_VALUE })
	})
})

// A command-style server with the credential written into its args.
const FAKE_ARG_TOKEN = 'fake-arg-token-not-a-secret'

function buildStoredArgsTools() {
	return {
		mcpServers: {
			meetings: {
				type: 'stdio',
				command: 'npx',
				// The update schema fills in env, so seed it to compare the stored row as-is.
				env: {},
				args: [
					'-y',
					'fake-remote-proxy',
					'https://mcp.example.test/mcp',
					'--header',
					`Authorization: Bearer ${FAKE_ARG_TOKEN}`,
				],
			},
		},
	}
}

function buildMaskedArgsTools() {
	const tools = buildStoredArgsTools()
	tools.mcpServers.meetings.args[4] = `Authorization: Bearer ${MASKED_VALUE}`
	return tools
}

async function seedWorkspaceWithArgsAgent() {
	const ws = await insertWorkspace(db, getTestActorId())
	const target = await insertActor(db, {
		type: 'agent',
		name: 'Args Agent',
		tools: buildStoredArgsTools(),
	})
	await addMember(ws.id, target.id, 'member')
	return { ws, target }
}

describe('Actor tool config redaction — tokens in args', () => {
	it('masks the token in args for a non-admin peer on get and keeps the rest readable', async () => {
		const { ws, target } = await seedWorkspaceWithArgsAgent()
		const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
		await addMember(ws.id, peer.id, 'member')

		const res = await createAppAs(peer.id).request(jsonGet(`/api/actors/${target.id}`))

		const text = await res.text()
		expect(res.status).toBe(200)
		expect(text).not.toContain(FAKE_ARG_TOKEN)
		expect(JSON.parse(text).tools).toEqual(buildMaskedArgsTools())
	})

	it('shows the real args to the actor itself and to an admin', async () => {
		const { ws, target } = await seedWorkspaceWithArgsAgent()
		const admin = await insertActor(db, { type: 'agent', name: 'Admin Agent' })
		await addMember(ws.id, admin.id, 'admin')

		for (const callerId of [target.id, admin.id]) {
			const res = await createAppAs(callerId).request(jsonGet(`/api/actors/${target.id}`))
			expect((await res.json()).tools).toEqual(buildStoredArgsTools())
		}
	})

	it('keeps every stored arg when an unrelated update sends the masked config back', async () => {
		const { target } = await seedWorkspaceWithArgsAgent()

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				description: 'unrelated edit',
				tools: buildMaskedArgsTools(),
			}),
		)

		expect(res.status).toBe(200)
		expect(await storedTools(target.id)).toEqual(buildStoredArgsTools())
	})

	it('rejects a masked arg sent with a changed url and saves nothing', async () => {
		const { target } = await seedWorkspaceWithArgsAgent()
		const tools = buildMaskedArgsTools()
		tools.mcpServers.meetings.args[2] = 'https://attacker.example.test/mcp'

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { description: 'should not save', tools }),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(FAKE_ARG_TOKEN)
		expect(await storedTools(target.id)).toEqual(buildStoredArgsTools())
		const [row] = await db
			.select({ description: actors.description })
			.from(actors)
			.where(eq(actors.id, target.id))
		expect(row.description).not.toBe('should not save')
	})
})

// The stored llm_config api key belongs to the stored provider.
const FAKE_LLM_KEY = 'fake-llm-key-not-a-secret'
const FAKE_NEW_LLM_KEY = 'fake-new-llm-key-not-a-secret'

async function seedAgentWithLlmKey() {
	const ws = await insertWorkspace(db, getTestActorId())
	const target = await insertActor(db, {
		type: 'agent',
		name: 'Keyed Agent',
		llmProvider: 'anthropic',
		llmConfig: { model: 'fake-model', api_key: FAKE_LLM_KEY },
	})
	await addMember(ws.id, target.id, 'member')
	return { ws, target }
}

async function storedLlm(id: string) {
	const [row] = await db
		.select({ llmProvider: actors.llmProvider, llmConfig: actors.llmConfig })
		.from(actors)
		.where(eq(actors.id, id))
	return row
}

describe('Actor llm_config key restore — PATCH /api/actors/:id', () => {
	it('keeps the stored key when the masked key comes back with the same provider', async () => {
		const { target } = await seedAgentWithLlmKey()

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_provider: 'anthropic',
				llm_config: { model: 'other-fake-model', api_key: MASKED_VALUE },
			}),
		)

		expect(res.status).toBe(200)
		expect(await storedLlm(target.id)).toEqual({
			llmProvider: 'anthropic',
			llmConfig: { model: 'other-fake-model', api_key: FAKE_LLM_KEY },
		})
	})

	it('rejects the masked key when the provider changes and leaves the row unchanged', async () => {
		const { target } = await seedAgentWithLlmKey()

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_provider: 'openai',
				llm_config: { model: 'fake-model', api_key: MASKED_VALUE },
			}),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(FAKE_LLM_KEY)
		expect(await storedLlm(target.id)).toEqual({
			llmProvider: 'anthropic',
			llmConfig: { model: 'fake-model', api_key: FAKE_LLM_KEY },
		})
	})

	it('saves a new key sent with a changed provider', async () => {
		const { target } = await seedAgentWithLlmKey()

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_provider: 'openai',
				llm_config: { model: 'fake-model', api_key: FAKE_NEW_LLM_KEY },
			}),
		)

		expect(res.status).toBe(200)
		expect(await storedLlm(target.id)).toEqual({
			llmProvider: 'openai',
			llmConfig: { model: 'fake-model', api_key: FAKE_NEW_LLM_KEY },
		})
	})
})
