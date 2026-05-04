import { randomUUID } from 'node:crypto'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
}

describe('Workspaces Integration', () => {
	describe('create and list', () => {
		it('creates a workspace with default settings', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Test Workspace' }),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.name).toBe('Test Workspace')
			expect(body.settings).toBeDefined()
			expect(body.settings.statuses).toBeDefined()
			expect(body.settings.display_names).toBeDefined()
		})

		it('lists workspaces for the current actor', async () => {
			const app = createApp()

			// Create two workspaces
			await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 1' }))
			await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 2' }))

			const res = await app.request(jsonGet('/api/workspaces'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('update settings', () => {
		it('merges settings on update', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Merge Test' }),
			)
			const ws = await createRes.json()

			// Update with partial settings
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			// Should have merged: new display_names + original statuses
			expect(updated.settings.display_names.insight).toBe('Signal')
			expect(updated.settings.statuses).toBeDefined()
		})

		it('returns 404 for nonexistent workspace', async () => {
			const app = createApp()
			const id = randomUUID()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})

		it('deep-merges llm_keys so a single-provider PATCH preserves siblings', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'LLM Keys Merge' }),
			)
			const ws = await createRes.json()

			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-AAA' } },
				}),
			)
			const second = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { openai: 'sk-oai-BBB' } },
				}),
			)
			const afterSet = await second.json()
			expect(afterSet.settings.llm_keys).toEqual({
				anthropic: 'sk-ant-AAA',
				openai: 'sk-oai-BBB',
			})

			// `null` inside llm_keys signals deletion; other providers stay.
			const third = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: null } },
				}),
			)
			const afterDelete = await third.json()
			expect(afterDelete.settings.llm_keys).toEqual({ openai: 'sk-oai-BBB' })
		})
	})

	describe('members', () => {
		it('adds and lists members', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Members Test' }),
			)
			const ws = await createRes.json()

			// Create another actor to add as member
			const newActor = await insertActor(db, { name: 'New Member', email: 'member@test.com' })

			// Add member
			const addRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: newActor.id,
					role: 'member',
				}),
			)
			expect(addRes.status).toBe(201)

			// List members
			const listRes = await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			expect(listRes.status).toBe(200)
			const members = await listRes.json()
			// Creator (owner) + auto-seeded Sindre (member) + new member
			expect(members).toHaveLength(3)
			expect(members.map((m: { role: string }) => m.role).sort()).toEqual([
				'member',
				'member',
				'owner',
			])
		})
	})
})
