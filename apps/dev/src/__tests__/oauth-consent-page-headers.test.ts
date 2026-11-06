import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app-factory'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

// The consent page has an Allow button, so it must refuse to be framed (clickjacking). It is a web
// route answered by the SPA fallthrough, so the headers come from the app, not from the page.

let staticDir: string

beforeAll(() => {
	staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskin-spa-'))
	fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>spa</title>')
})

afterAll(() => {
	fs.rmSync(staticDir, { recursive: true, force: true })
})

function buildApp() {
	const deps: AppDeps = {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
	return createApp(deps, { includeExtensions: false, staticDir })
}

describe('GET /oauth/authorize', () => {
	it('is served with frame-ancestors none and X-Frame-Options DENY, query string and all', async () => {
		const res = await buildApp().request(
			'/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fx&state=abc',
		)

		expect(res.status).toBe(200)
		expect(await res.text()).toContain('<title>spa</title>')
		expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
		expect(res.headers.get('X-Frame-Options')).toBe('DENY')
	})

	it('leaves other pages alone', async () => {
		const res = await buildApp().request('/login')

		expect(res.status).toBe(200)
		expect(res.headers.get('X-Frame-Options')).toBeNull()
		expect(res.headers.get('Content-Security-Policy')).toBeNull()
	})
})
