import type { Database } from '@maskin/db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_FORWARD_HEADER, getMcpForwardMarker } from '../forward-marker'
import { authMiddleware } from '../middleware'
import { getOAuthPin } from '../oauth-pin'
import { validateOAuthAccessToken } from '../oauth-token'
import { createMockDb } from './helpers'

vi.mock('../oauth-token', () => ({ validateOAuthAccessToken: vi.fn() }))

const PINNED = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ACTOR = '33333333-3333-4333-8333-333333333333'
const MAT = 'mat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP'

const context = (overrides: Record<string, unknown> = {}) => ({
	actorId: ACTOR,
	type: 'human',
	workspaceId: PINNED,
	grantId: '44444444-4444-4444-8444-444444444444',
	clientId: 'https://claude.ai/client',
	scope: 'mcp',
	resource: 'https://maskin.io/mcp',
	expiresAt: new Date(Date.now() + 3_600_000),
	...overrides,
})

type Env = { Variables: { actorId: string; actorType: string } }

function createApp(db: Database) {
	const app = new Hono<Env>()
	app.use('/api/*', authMiddleware(db, { cacheTtlMs: 0 }))
	// Registered the way the real app registers them, so the allowlist sees real patterns.
	app.get('/api/objects', (c) =>
		c.json({
			actorId: c.get('actorId'),
			actorType: c.get('actorType'),
			workspaceHeader: c.req.header('X-Workspace-Id') ?? null,
			pin: getOAuthPin() ?? null,
		}),
	)
	app.post('/api/workspaces', (c) => c.json({ created: true }))
	app.get('/api/not-classified-anywhere', (c) => c.json({ ok: true }))
	return app
}

function request(
	app: ReturnType<typeof createApp>,
	headers: Record<string, string> = {},
	path = '/api/objects',
) {
	return app.request(path, {
		headers: {
			Authorization: `Bearer ${MAT}`,
			[MCP_FORWARD_HEADER]: getMcpForwardMarker(),
			...headers,
		},
	})
}

const member = [{ actorId: ACTOR }]

beforeEach(() => {
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	vi.mocked(validateOAuthAccessToken).mockResolvedValue(context())
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.mocked(validateOAuthAccessToken).mockReset()
})

describe('authMiddleware: mat_ access token', () => {
	it('accepts a valid token and resolves to the person behind it', async () => {
		const res = await request(createApp(createMockDb([member])))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actorId).toBe(ACTOR)
		expect(body.actorType).toBe('human')
	})

	it('puts the pin in scope for the rest of the request', async () => {
		const res = await request(createApp(createMockDb([member])))
		const body = await res.json()
		expect(body.pin).toMatchObject({ workspaceId: PINNED, clientId: 'https://claude.ai/client' })
	})

	it('does not leak the pin to a caller that is not OAuth', async () => {
		expect(getOAuthPin()).toBeUndefined()
	})

	it('fills in the pinned workspace when the request sends no X-Workspace-Id', async () => {
		const res = await request(createApp(createMockDb([member])))
		expect((await res.json()).workspaceHeader).toBe(PINNED)
	})

	it('accepts an X-Workspace-Id that equals the pin', async () => {
		const res = await request(createApp(createMockDb([member])), { 'X-Workspace-Id': PINNED })
		expect(res.status).toBe(200)
	})

	it('refuses an X-Workspace-Id that differs from the pin with workspace_mismatch', async () => {
		const res = await request(createApp(createMockDb([member])), { 'X-Workspace-Id': OTHER })
		expect(res.status).toBe(403)
		expect((await res.json()).error.oauth_error).toBe('workspace_mismatch')
	})

	it('takes the workspace from the grant, never from the header', async () => {
		vi.mocked(validateOAuthAccessToken).mockResolvedValue(context({ workspaceId: OTHER }))
		const res = await request(createApp(createMockDb([member])), { 'X-Workspace-Id': PINNED })
		expect(res.status).toBe(403)
	})

	it('answers 401 when the person is no longer a member of the pinned workspace', async () => {
		const res = await request(createApp(createMockDb([[]])))
		expect(res.status).toBe(401)
	})

	it('answers 401 for an unknown, expired or revoked token', async () => {
		vi.mocked(validateOAuthAccessToken).mockResolvedValue(null)
		const res = await request(createApp(createMockDb([member])))
		expect(res.status).toBe(401)
		expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token')
	})

	it('answers 401 for a token whose expiry has passed even if it was served from cache', async () => {
		vi.mocked(validateOAuthAccessToken).mockResolvedValue(
			context({ expiresAt: new Date(Date.now() - 1) }),
		)
		const res = await request(createApp(createMockDb([member])))
		expect(res.status).toBe(401)
	})

	it('answers 401 for a refresh token presented as a bearer', async () => {
		const res = await request(createApp(createMockDb([member])), {
			Authorization: 'Bearer mrt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP',
		})
		expect(res.status).toBe(401)
		expect(vi.mocked(validateOAuthAccessToken)).not.toHaveBeenCalled()
	})

	it('rejects a valid token that arrives without the forward marker', async () => {
		const app = createApp(createMockDb([member]))
		const res = await app.request('/api/objects', { headers: { Authorization: `Bearer ${MAT}` } })
		expect(res.status).toBe(401)
		expect(vi.mocked(validateOAuthAccessToken)).not.toHaveBeenCalled()
	})

	it('rejects a valid token that arrives with the wrong forward marker', async () => {
		const res = await request(createApp(createMockDb([member])), { [MCP_FORWARD_HEADER]: 'guess' })
		expect(res.status).toBe(401)
	})

	it('answers 403 insufficient_scope on a route that is refused for OAuth tokens', async () => {
		const app = createApp(createMockDb([member]))
		const res = await app.request('/api/workspaces', {
			method: 'POST',
			headers: { Authorization: `Bearer ${MAT}`, [MCP_FORWARD_HEADER]: getMcpForwardMarker() },
		})
		expect(res.status).toBe(403)
		expect((await res.json()).error.oauth_error).toBe('insufficient_scope')
		expect(res.headers.get('WWW-Authenticate')).toContain('insufficient_scope')
	})

	it('answers 403 on a route nobody has classified, and on a path with no route at all', async () => {
		const app = createApp(createMockDb([member, member]))
		expect((await request(app, {}, '/api/not-classified-anywhere')).status).toBe(403)
		expect((await request(app, {}, '/api/nothing-here')).status).toBe(403)
	})

	it('is skipped entirely when the kill switch is off, with the same 401 an unknown token gets', async () => {
		vi.unstubAllEnvs()
		const res = await request(createApp(createMockDb([member])))
		expect(res.status).toBe(401)
		expect((await res.json()).error.message).toBe('Invalid token format')
		expect(vi.mocked(validateOAuthAccessToken)).not.toHaveBeenCalled()
	})
})
