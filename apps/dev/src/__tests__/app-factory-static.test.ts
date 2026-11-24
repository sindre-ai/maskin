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

function buildApp(corsOrigins?: string[]) {
	const deps: AppDeps = {
		db: forbiddenDb,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false, staticDir, corsOrigins })
}

beforeAll(() => {
	staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskin-static-'))
	fs.mkdirSync(path.join(staticDir, 'assets'))
	fs.mkdirSync(path.join(staticDir, 'fonts'))
	fs.writeFileSync(path.join(staticDir, 'fonts', 'real.woff2'), 'font')
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

/**
 * The web app can load /assets and /fonts from a second host (VITE_API_ORIGIN) that has no CDN in
 * front, so the app itself sends the CORS and cache headers the browser needs.
 */
describe('static files loaded from the API host', () => {
	const webOrigin = 'https://maskin.io'

	it('allows the web origin on a built asset and a font, without credentials', async () => {
		for (const url of ['/assets/index-real.js', '/fonts/real.woff2']) {
			const res = await buildApp([webOrigin]).request(url, { headers: { Origin: webOrigin } })
			expect(res.status).toBe(200)
			expect(res.headers.get('access-control-allow-origin')).toBe(webOrigin)
			expect(res.headers.get('access-control-allow-credentials')).toBeNull()
		}
	})

	it('does not allow another origin', async () => {
		const res = await buildApp([webOrigin]).request('/assets/index-real.js', {
			headers: { Origin: 'https://evil.example' },
		})
		expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
	})

	it('caches a hashed asset for a year and a font for a day', async () => {
		const asset = await buildApp().request('/assets/index-real.js')
		expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
		const font = await buildApp().request('/fonts/real.woff2')
		expect(font.headers.get('cache-control')).toBe('public, max-age=86400')
	})

	it('answers an API preflight with a cache time, and exposes the headers the client reads', async () => {
		const pre = await buildApp([webOrigin]).request('/api/objects', {
			method: 'OPTIONS',
			headers: {
				Origin: webOrigin,
				'Access-Control-Request-Method': 'GET',
				'Access-Control-Request-Headers': 'authorization,x-workspace-id',
			},
		})
		expect(pre.status).toBe(204)
		expect(pre.headers.get('access-control-allow-origin')).toBe(webOrigin)
		expect(pre.headers.get('access-control-allow-credentials')).toBe('true')
		expect(pre.headers.get('access-control-max-age')).toBe('7200')
		const health = await buildApp([webOrigin]).request('/api/health', {
			headers: { Origin: webOrigin },
		})
		expect(health.headers.get('access-control-expose-headers')).toBe(
			'Retry-After,Content-Disposition',
		)
	})
})
