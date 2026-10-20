import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app-factory'
import { buildAppleAppSiteAssociation } from '../lib/apple-app-site-association'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

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

describe('buildAppleAppSiteAssociation', () => {
	it('returns null without a well-formed team id', () => {
		expect(buildAppleAppSiteAssociation(undefined)).toBeNull()
		expect(buildAppleAppSiteAssociation('short')).toBeNull()
		expect(buildAppleAppSiteAssociation('abcdefghij')).toBeNull()
	})

	it('covers the invite path and the existing deep links', () => {
		const aasa = buildAppleAppSiteAssociation('ABCDE12345')
		const detail = aasa?.applinks.details[0]
		expect(detail?.appIDs).toEqual(['ABCDE12345.io.maskin.app'])
		expect(detail?.components.map((c) => c['/'])).toEqual([
			'/invite',
			'/*/objects/*',
			'/*/chats/*',
			'/*/notifications',
		])
	})
})

describe('GET /.well-known/apple-app-site-association', () => {
	const original = process.env.APPLE_TEAM_ID
	afterEach(() => {
		if (original === undefined) Reflect.deleteProperty(process.env, 'APPLE_TEAM_ID')
		else process.env.APPLE_TEAM_ID = original
	})

	it('serves JSON without auth when configured', async () => {
		process.env.APPLE_TEAM_ID = 'ABCDE12345'
		const res = await buildApp().request('/.well-known/apple-app-site-association')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		expect((await res.json()).applinks.details[0].appIDs[0]).toBe('ABCDE12345.io.maskin.app')
	})

	it('returns 404 when the team id is not configured', async () => {
		Reflect.deleteProperty(process.env, 'APPLE_TEAM_ID')
		const res = await buildApp().request('/.well-known/apple-app-site-association')
		expect(res.status).toBe(404)
	})
})
