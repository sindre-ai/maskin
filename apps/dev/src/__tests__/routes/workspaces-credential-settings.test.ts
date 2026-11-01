import { randomUUID } from 'node:crypto'
import { buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

const PINNED_FILE_ID = randomUUID()

// Who gets the credential settings back from the workspace routes, and what the
// PATCH event records. Obviously fake secret values only.
describe('Workspace credential settings by caller', () => {
	describe('GET /api/workspaces', () => {
		// Obviously fake values only.
		const FAKE_SECRETS = ['sk-ant-fake-stored', 'sk-fake-custom', 'fake-oauth-token', 'cus_fake']
		const buildSecretWorkspace = () =>
			buildWorkspace({
				enterpriseGranted: true,
				settings: {
					pinned_files: [PINNED_FILE_ID],
					max_concurrent_sessions: 5,
					llm_keys: { anthropic: 'sk-ant-fake-stored' },
					custom_llm: { enabled: true, api_key: 'sk-fake-custom', model: 'model-a' },
					claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
					billing: { plan: 'team', stripe_customer_id: 'cus_fake' },
				},
			})
		const SHARED_SETTINGS = { pinned_files: [PINNED_FILE_ID], max_concurrent_sessions: 5 }

		it.each([
			['a plain member key', 'human', 'member'],
			['an agent key with the admin role', 'agent', 'admin'],
			['an agent key with the owner role', 'agent', 'owner'],
		])('hides the credential settings from %s and keeps the other keys', async (_l, type, role) => {
			const ws = { ...buildSecretWorkspace(), role }
			const { app, mockResults } = createTestApp(
				workspacesRoutes,
				'/api/workspaces',
				'caller',
				type,
			)
			mockResults.select = [ws]

			const res = await app.request(jsonGet('/api/workspaces'))

			expect(res.status).toBe(200)
			const [row] = await res.json()
			expect(row.settings).toEqual(SHARED_SETTINGS)
			expect(row.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
			for (const secret of FAKE_SECRETS) expect(JSON.stringify(row)).not.toContain(secret)
		})

		it.each([
			['human owner', 'owner'],
			['human admin', 'admin'],
		])('gives a %s the settings without any key, plus llm_configured', async (_l, role) => {
			const ws = { ...buildSecretWorkspace(), role }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [ws]

			const res = await app.request(jsonGet('/api/workspaces'))

			const [row] = await res.json()
			expect(row.settings).toEqual({
				...SHARED_SETTINGS,
				custom_llm: { enabled: true, model: 'model-a' },
				claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
				billing: { plan: 'team', stripe_customer_id: 'cus_fake' },
			})
			expect(row.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
			for (const secret of ['sk-ant-fake-stored', 'sk-fake-custom']) {
				expect(JSON.stringify(row)).not.toContain(secret)
			}
		})

		it('reports llm_configured false for a workspace with no stored key', async () => {
			const ws = { ...buildWorkspace(), role: 'member' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [ws]

			const [row] = await (await app.request(jsonGet('/api/workspaces'))).json()

			expect(row.llm_configured).toEqual({ anthropic: false, openai: false, custom_llm: false })
		})
	})

	describe('PATCH /api/workspaces/:id responses and events', () => {
		const MEMBER = [{ role: 'member' }]
		const HUMAN_OWNER = [{ role: 'owner', type: 'human' }]
		const PLAIN_MEMBER = [{ role: 'member', type: 'human' }]
		const AGENT_ADMIN = [{ role: 'admin', type: 'agent' }]
		// Obviously fake values only.
		const FAKE_SECRETS = ['sk-ant-fake-stored', 'sk-fake-custom', 'fake-oauth-token']
		const buildSecretWorkspace = () =>
			buildWorkspace({
				enterpriseGranted: true,
				settings: {
					pinned_files: [PINNED_FILE_ID],
					llm_keys: { anthropic: 'sk-ant-fake-stored' },
					custom_llm: { enabled: true, api_key: 'sk-fake-custom', model: 'model-a' },
					claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
				},
			})

		it('lets a member spread a GET response back: 200, and the stored keys are not touched', async () => {
			const ws = buildSecretWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			// GET: the list row, the member counts, the default workspace. PATCH: membership, the row, the admin lookup.
			mockResults.selectQueue = [[{ ...ws, role: 'member' }], [], [], MEMBER, [ws], PLAIN_MEMBER]
			mockResults.update = [ws]

			const [listed] = await (await app.request(jsonGet('/api/workspaces'))).json()
			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { ...listed.settings, max_concurrent_sessions: 7 },
				}),
			)

			expect(res.status).toBe(200)
			// The row the handler writes still carries the stored credentials.
			expect(calls.updates[0]).toMatchObject({
				settings: {
					max_concurrent_sessions: 7,
					llm_keys: { anthropic: 'sk-ant-fake-stored' },
					custom_llm: { api_key: 'sk-fake-custom' },
					claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
				},
			})
			const body = await res.json()
			for (const secret of FAKE_SECRETS) expect(JSON.stringify(body)).not.toContain(secret)
			expect(body.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
		})

		it('returns an agent holding the admin role the response without credential settings', async () => {
			const ws = buildSecretWorkspace()
			const { app, mockResults } = createTestApp(
				workspacesRoutes,
				'/api/workspaces',
				'agent-1',
				'agent',
			)
			mockResults.selectQueue = [MEMBER, [ws], AGENT_ADMIN]
			mockResults.update = [ws]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { pinned_files: [PINNED_FILE_ID] },
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.settings).toEqual({ pinned_files: [PINNED_FILE_ID] })
			expect(body.llm_configured.anthropic).toBe(true)
		})

		it('returns a human owner the settings without any key', async () => {
			const ws = buildSecretWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [MEMBER, [ws], HUMAN_OWNER]
			mockResults.update = [ws]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { pinned_files: [PINNED_FILE_ID] },
				}),
			)

			const body = await res.json()
			expect(body.settings.llm_keys).toBeUndefined()
			expect(body.settings.custom_llm).toEqual({ enabled: true, model: 'model-a' })
			expect(body.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
			for (const secret of ['sk-ant-fake-stored', 'sk-fake-custom']) {
				expect(JSON.stringify(body)).not.toContain(secret)
			}
		})

		it('writes an updated event with field names only and no settings values', async () => {
			const ws = buildSecretWorkspace()
			const updated = {
				...ws,
				name: 'Renamed',
				settings: { ...ws.settings, max_concurrent_sessions: 7 },
			}
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [MEMBER, [ws], HUMAN_OWNER]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					name: 'Renamed',
					settings: { max_concurrent_sessions: 7 },
				}),
			)

			expect(res.status).toBe(200)
			const event = calls.inserts.find(
				(row) => (row as { entityType?: string }).entityType === 'workspace',
			) as { action: string; data: unknown }
			expect(event.action).toBe('updated')
			expect(event.data).toEqual({
				changes: [{ field: 'name', old: ws.name, new: 'Renamed' }],
				changed_settings_keys: ['max_concurrent_sessions'],
			})
			const serialized = JSON.stringify(event)
			for (const secret of FAKE_SECRETS) expect(serialized).not.toContain(secret)
			expect(serialized).not.toContain('claude_oauth')
			expect(serialized).not.toContain('llm_keys')
		})
	})
})
