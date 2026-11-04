import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * A signed-out phone has no API key, so POST /api/devices/unregister is on the auth allowlist in
 * app-factory.ts; the device secret in the body is the credential. This pins that exemption to
 * that one path and method. The db handed to createApp throws on any access, so a request that
 * wrongly reached authentication (which reads the db for a key) would fail loudly.
 */

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched')
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

const post = (path: string, body: unknown) =>
	buildApp().request(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('device unregister auth allowlist', () => {
	it('lets POST /api/devices/unregister past authentication (an empty body gets a 400, not a 401)', async () => {
		const res = await post('/api/devices/unregister', {})
		expect(res.status).toBe(400)
	})

	it('still requires an API key to register a device', async () => {
		const res = await post('/api/devices', {})
		expect(res.status).toBe(401)
	})

	it('still requires an API key for the authenticated delete', async () => {
		const res = await buildApp().request(`/api/devices/${'a'.repeat(64)}`, { method: 'DELETE' })
		expect(res.status).toBe(401)
	})

	it('does not extend the exemption to other paths under /api/devices', async () => {
		const res = await post('/api/devices/unregister/extra', {})
		expect(res.status).toBe(401)
	})

	it('does not extend the exemption to other methods on the same path', async () => {
		const res = await buildApp().request('/api/devices/unregister', { method: 'DELETE' })
		expect(res.status).toBe(401)
	})
})
