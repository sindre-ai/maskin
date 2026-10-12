import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * The timing middleware only helps if it is actually registered on the real
 * app, ahead of auth, so even a rejected request is timed.
 */
function buildApp() {
	const deps: AppDeps = {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

describe('app-wide request timing', () => {
	it('adds Server-Timing to a public API response', async () => {
		const res = await buildApp().request('/api/health')

		expect(res.status).toBe(200)
		expect(res.headers.get('Server-Timing')).toMatch(/app;dur=\d/)
	})

	it('also times a request that auth rejects', async () => {
		const res = await buildApp().request('/api/objects')

		expect(res.status).toBe(401)
		expect(res.headers.get('Server-Timing')).toMatch(/app;dur=\d/)
	})
})
