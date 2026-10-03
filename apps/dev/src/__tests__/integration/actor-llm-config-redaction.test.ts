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

// Obviously fake value only; the real thing never appears in a test.
const FAKE_KEY = 'fake-llm-key-not-a-secret'

function storedLlmConfig() {
	return { api_key: FAKE_KEY, model: 'fake-model' }
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

async function storedRow(id: string) {
	const [row] = await db
		.select({ llmConfig: actors.llmConfig, llmProvider: actors.llmProvider })
		.from(actors)
		.where(eq(actors.id, id))
	return row
}

/** A workspace owned by the test actor, holding an agent with a stored api_key. */
async function seedWorkspaceWithKeyedAgent() {
	const ws = await insertWorkspace(db, getTestActorId())
	const target = await insertActor(db, {
		type: 'agent',
		name: 'Keyed Agent',
		llmProvider: 'anthropic',
		llmConfig: storedLlmConfig(),
	})
	await addMember(ws.id, target.id, 'member')
	const peer = await insertActor(db, { type: 'agent', name: 'Peer Agent' })
	await addMember(ws.id, peer.id, 'member')
	return { ws, target, peer }
}

describe('Actor llm_config api_key redaction — GET /api/actors/:id', () => {
	it('masks api_key for a workspace member who is not an admin', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(jsonGet(`/api/actors/${target.id}`))

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_KEY)
		expect(JSON.parse(text).llm_config).toEqual({ api_key: MASKED_VALUE, model: 'fake-model' })
	})

	it('shows the real api_key to the actor itself', async () => {
		const { target } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(target.id).request(jsonGet(`/api/actors/${target.id}`))

		expect((await res.json()).llm_config).toEqual(storedLlmConfig())
	})

	it('shows the real api_key to an owner of a workspace the actor belongs to', async () => {
		const { target } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(getTestActorId()).request(jsonGet(`/api/actors/${target.id}`))

		expect((await res.json()).llm_config).toEqual(storedLlmConfig())
	})

	it('masks api_key for an admin of a different workspace the actor is not in', async () => {
		const { target } = await seedWorkspaceWithKeyedAgent()
		const outsider = await insertActor(db, { type: 'agent', name: 'Outside Admin' })
		const otherWs = await insertWorkspace(db, getTestActorId())
		await addMember(otherWs.id, outsider.id, 'admin')

		const res = await createAppAs(outsider.id).request(jsonGet(`/api/actors/${target.id}`))

		const text = await res.text()
		expect(text).not.toContain(FAKE_KEY)
		expect(JSON.parse(text).llm_config.api_key).toBe(MASKED_VALUE)
	})
})

describe('Actor llm_config api_key redaction — PATCH /api/actors/:id', () => {
	it('keeps the stored key when a masked config is sent back with an unrelated change', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()
		const app = createAppAs(peer.id)
		const read = await (await app.request(jsonGet(`/api/actors/${target.id}`))).json()

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				description: 'edited by a peer',
				llm_config: read.llm_config,
			}),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_KEY)
		expect(JSON.parse(text).description).toBe('edited by a peer')
		expect((await storedRow(target.id)).llmConfig).toEqual(storedLlmConfig())
	})

	it('keeps the stored key when only the model changes', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_config: { api_key: MASKED_VALUE, model: 'other-model' },
			}),
		)

		expect(res.status).toBe(200)
		expect((await storedRow(target.id)).llmConfig).toEqual({
			api_key: FAKE_KEY,
			model: 'other-model',
		})
	})

	it('still saves a real new key', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_config: { api_key: 'fake-rotated', model: 'fake-model' },
			}),
		)

		expect(res.status).toBe(200)
		expect((await storedRow(target.id)).llmConfig).toEqual({
			api_key: 'fake-rotated',
			model: 'fake-model',
		})
	})

	it('rejects a masked key sent with a changed provider and leaves the stored config untouched', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, {
				llm_provider: 'openai',
				llm_config: { api_key: MASKED_VALUE },
			}),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(FAKE_KEY)
		const row = await storedRow(target.id)
		expect(row.llmConfig).toEqual(storedLlmConfig())
		expect(row.llmProvider).toBe('anthropic')
	})

	it('rejects a masked key when the actor has no stored key', async () => {
		const target = await insertActor(db, { type: 'agent', name: 'No Key Agent' })

		const res = await createAppAs(getTestActorId()).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { llm_config: { api_key: MASKED_VALUE } }),
		)

		expect(res.status).toBe(400)
	})

	it('masks api_key in the response for a non-admin caller', async () => {
		const { target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(
			jsonRequest('PATCH', `/api/actors/${target.id}`, { description: 'no llm_config in body' }),
		)

		const text = await res.text()
		expect(text).not.toContain(FAKE_KEY)
		expect(JSON.parse(text).llm_config.api_key).toBe(MASKED_VALUE)
	})
})

describe('Actor llm_config api_key redaction — pause', () => {
	it('masks api_key in the pause response for a non-admin caller', async () => {
		const { ws, target, peer } = await seedWorkspaceWithKeyedAgent()

		const res = await createAppAs(peer.id).request(
			jsonRequest('POST', `/api/actors/${target.id}/pause`, undefined, { 'x-workspace-id': ws.id }),
		)

		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain(FAKE_KEY)
		expect(JSON.parse(text).llm_config.api_key).toBe(MASKED_VALUE)
	})
})
