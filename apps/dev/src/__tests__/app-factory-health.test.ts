import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * The container healthcheck (Docker and Coolify) probes GET /api/health. If that touched the
 * database, a stalled pool would mark the container unhealthy and the proxy would drop the whole
 * site ("Site not available"), and Docker never restarts an unhealthy container. So /api/health is
 * liveness only; the database-aware check is /api/health/db. The db handed to createApp throws on
 * any access (or never answers), so a /api/health that reached it would fail here.
 */

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched')
		},
	},
) as unknown as Database

function buildApp(db: Database) {
	const deps: AppDeps = {
		db,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false })
}

describe('GET /api/health (container liveness)', () => {
	it('answers 200 without touching the database', async () => {
		const res = await buildApp(forbiddenDb).request('/api/health')
		expect(res.status).toBe(200)
		expect((await res.json()).status).toBe('ok')
	})
})

describe('GET /api/health/db (database readiness)', () => {
	it('answers 503 when the database fails, with no API key needed', async () => {
		const failingDb = {
			execute: async () => {
				throw new Error('connection terminated')
			},
		} as unknown as Database
		const res = await buildApp(failingDb).request('/api/health/db')
		expect(res.status).toBe(503)
		expect((await res.json()).status).toBe('unavailable')
	})

	it('answers 200 when the database answers', async () => {
		const okDb = { execute: async () => [{ '?column?': 1 }] } as unknown as Database
		const res = await buildApp(okDb).request('/api/health/db')
		expect(res.status).toBe(200)
	})
})
