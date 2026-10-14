import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * /mcp itself. With the Claude sign-in switch on, a caller with no credential is answered with the
 * 401 challenge before anything reads the database, and GET and DELETE stay a bare 405.
 */
describe('/mcp without a credential', () => {
	beforeEach(() => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		vi.stubEnv('MASKIN_OAUTH_ISSUER', '')
		vi.stubEnv('WEB_APP_URL', '')
		vi.stubEnv('FRONTEND_URL', '')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('answers an unauthenticated POST with 401 and the challenge without touching the database', async () => {
		const res = await buildApp().request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		})

		expect(res.status).toBe(401)
		expect(res.headers.get('WWW-Authenticate')).toBe(
			'Bearer resource_metadata="https://maskin.io/.well-known/oauth-protected-resource/mcp", scope="mcp"',
		)
		expect(await res.json()).toEqual({
			jsonrpc: '2.0',
			error: { code: -32001, message: 'Authentication required' },
			id: null,
		})
	})

	it('lets a browser client read the challenge: WWW-Authenticate is exposed', async () => {
		const res = await buildApp().request('/mcp', {
			method: 'POST',
			headers: { Origin: 'https://claude.ai', 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		})

		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
		expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate')
	})

	it.each(['GET', 'DELETE'])(
		'answers %s with a bare 405 without touching the database',
		async (method) => {
			const res = await buildApp().request('/mcp', { method })

			expect(res.status).toBe(405)
			expect(await res.text()).toBe('Method Not Allowed')
		},
	)

	it('serves the discovery documents without touching the database', async () => {
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-authorization-server',
		]) {
			const res = await buildApp().request(path)

			expect(res.status).toBe(200)
			expect(res.headers.get('Content-Type')).toContain('application/json')
		}
	})

	it('answers the discovery paths with 404 when the switch is off', async () => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-authorization-server',
		]) {
			expect((await buildApp().request(path)).status).toBe(404)
		}
	})
})

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
