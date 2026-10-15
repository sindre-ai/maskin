import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * MCP clients probe the POST-only linkedin-unipile MCP endpoints with GET (to
 * open a server-to-client stream) and retry, ~250k times a week. The route
 * answers every GET with a bare 405, but only after authMiddleware had spent
 * two DB round trips authenticating the probe. The app now answers it first.
 *
 * The db handed to createApp throws on any property access, so a probe that
 * reaches authentication fails loudly instead of quietly costing a query.
 */

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched by an unauthenticated MCP probe')
		},
	},
) as unknown as Database

function buildApp() {
	const deps: AppDeps = {
		db: forbiddenDb,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

const BASE = '/api/integrations/linkedin-unipile/mcp'

describe('linkedin-unipile MCP GET probe', () => {
	it('answers GET on an instance endpoint with 405 without authenticating', async () => {
		const res = await buildApp().request(`${BASE}/linkedin-someone-personal`)

		expect(res.status).toBe(405)
		expect(await res.text()).toBe('Method Not Allowed')
	})

	it('answers GET on the bare endpoint with 405 without authenticating', async () => {
		const res = await buildApp().request(BASE)

		expect(res.status).toBe(405)
	})

	it('still requires authentication for POST on the same path', async () => {
		const res = await buildApp().request(`${BASE}/linkedin-someone-personal`, { method: 'POST' })

		expect(res.status).toBe(401)
	})

	it('does not extend the exemption to other paths under the integration', async () => {
		const res = await buildApp().request('/api/integrations/linkedin-unipile/mcp/a/b')

		expect(res.status).toBe(401)
	})
})
