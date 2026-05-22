import { vi } from 'vitest'

// Mock chrome-remote-interface — never actually opens a CDP connection in tests.
vi.mock('chrome-remote-interface', () => ({
	default: vi.fn(),
}))

import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import type { AuthBrowserManager } from '../../services/auth-browser-manager'
import { jsonRequest } from '../helpers'
import { createTestContext } from '../setup'

import linkedinAuthBrowserApp from '../../routes/integrations-linkedin'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		authBrowserManager: AuthBrowserManager
	}
}

function createMockAuthBrowserManager(overrides?: Partial<Record<string, unknown>>) {
	return {
		startSession: vi.fn().mockResolvedValue({
			id: 'abs-test-1',
			accessToken: 'tok-test-1',
			expiresAt: new Date(Date.now() + 600_000),
		}),
		stopSession: vi.fn().mockResolvedValue(undefined),
		getCdpEndpoint: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 49876 }),
		waitForReady: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 49876 }),
		markCaptured: vi.fn().mockResolvedValue(undefined),
		reapExpired: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as AuthBrowserManager
}

function createApp(
	authBrowserManager: AuthBrowserManager,
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	const app = new OpenAPIHono<Env>()
	const { db, mockResults, calls } = createTestContext()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('authBrowserManager', authBrowserManager)
		await next()
	})
	app.route('/api/integrations', linkedinAuthBrowserApp)
	return { app, db, mockResults, calls }
}

describe('POST /api/integrations/linkedin/auth-browser/start', () => {
	it('returns id + access_token + expires_at on success', async () => {
		const mgr = createMockAuthBrowserManager()
		const { app, mockResults } = createApp(mgr)
		mockResults.insert = []

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/integrations/linkedin/auth-browser/start',
				{},
				{ 'X-Workspace-Id': 'ws-1' },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe('abs-test-1')
		expect(body.access_token).toBe('tok-test-1')
		expect(typeof body.expires_at).toBe('string')
		expect(mgr.startSession).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			actorId: 'test-actor-id',
			provider: 'linkedin',
		})
	})

	it('returns 400 when X-Workspace-Id header is missing', async () => {
		const mgr = createMockAuthBrowserManager()
		const { app } = createApp(mgr)
		const res = await app.request(
			jsonRequest('POST', '/api/integrations/linkedin/auth-browser/start', {}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when AuthBrowserManager rejects (e.g. concurrency cap)', async () => {
		const mgr = createMockAuthBrowserManager({
			startSession: vi.fn().mockRejectedValue(new Error('Another connect flow is running')),
		})
		const { app } = createApp(mgr)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/integrations/linkedin/auth-browser/start',
				{},
				{ 'X-Workspace-Id': 'ws-1' },
			),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toMatch(/Another connect flow/)
	})
})

describe('POST /api/integrations/linkedin/auth-browser/:id/cancel', () => {
	it('returns 404 when the session row does not exist', async () => {
		const mgr = createMockAuthBrowserManager()
		const { app, mockResults } = createApp(mgr)
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', '/api/integrations/linkedin/auth-browser/abs-x/cancel'),
		)
		expect(res.status).toBe(404)
		expect(mgr.stopSession).not.toHaveBeenCalled()
	})

	it('stops the session and revokes pending integration row', async () => {
		const mgr = createMockAuthBrowserManager()
		const { app, mockResults, calls } = createApp(mgr)
		mockResults.select = [
			{ id: 'abs-x', workspaceId: 'ws-1', actorId: 'actor-1', provider: 'linkedin' },
		]

		const res = await app.request(
			jsonRequest('POST', '/api/integrations/linkedin/auth-browser/abs-x/cancel'),
		)
		expect(res.status).toBe(200)
		expect(mgr.stopSession).toHaveBeenCalledWith('abs-x')

		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.status).toBe('revoked')
	})
})

describe('POST /api/integrations/linkedin/auth-browser/:id/:accessToken/input', () => {
	it('returns 400 when endpoint is not ready (token invalid or session not ready)', async () => {
		const mgr = createMockAuthBrowserManager({
			getCdpEndpoint: vi.fn().mockResolvedValue(null),
		})
		const { app } = createApp(mgr)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/integrations/linkedin/auth-browser/abs-1/wrong-token/input?type=mouse',
				{ type: 'mouseMoved', x: 100, y: 100 },
			),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when type query param is unknown', async () => {
		const mgr = createMockAuthBrowserManager()
		const { app } = createApp(mgr)
		// CDP() default mock returns undefined — the input branch never runs because
		// type=banana hits the unknown-type guard before opening the CDP client.
		const res = await app.request(
			jsonRequest('POST', '/api/integrations/linkedin/auth-browser/abs-1/tok-1/input?type=banana', {
				x: 0,
				y: 0,
			}),
		)
		expect(res.status).toBe(400)
	})
})
