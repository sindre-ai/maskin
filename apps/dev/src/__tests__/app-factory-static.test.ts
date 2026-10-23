import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

/**
 * The SPA fallback answers client routes with index.html, but a request for a file that does
 * not exist must be a 404. Otherwise a CDN caches HTML under a .js URL and browsers refuse the
 * module script. No database: the app is built the way viewer-route-guard.test.ts builds it.
 */

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched while serving static files')
		},
	},
) as unknown as Database

let staticDir: string

function buildApp() {
	const deps: AppDeps = {
		db: forbiddenDb,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false, staticDir })
}

beforeAll(() => {
	staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskin-static-'))
	fs.mkdirSync(path.join(staticDir, 'assets'))
	fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>')
	fs.writeFileSync(path.join(staticDir, 'assets', 'index-real.js'), 'export default 1')
})

afterAll(() => {
	fs.rmSync(staticDir, { recursive: true, force: true })
})

describe('SPA static fallback', () => {
	it('serves a built asset that exists', async () => {
		const res = await buildApp().request('/assets/index-real.js')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('javascript')
	})

	it('serves index.html for a client route', async () => {
		const res = await buildApp().request('/workspaces')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/html')
	})

	it.each([
		'/assets/index-missing.js',
		'/assets/chunk-missing.css',
		'/fonts/missing.woff2',
		'/missing.js',
		'/favicon-missing.svg',
	])('returns an uncacheable 404, not index.html, for missing file %s', async (url) => {
		const res = await buildApp().request(url)
		expect(res.status).toBe(404)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(res.headers.get('content-type')).not.toContain('text/html')
	})
})
