import { randomUUID } from 'node:crypto'
import { sha256Hex } from '@maskin/auth'
import { MCP_OAUTH_CLAUDE_CLIENT_ID } from '@maskin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEvent } = vi.hoisted(() => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent }))

import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import oauthRoutes from '../../routes/oauth'
import { buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const STATE = 'state-abcdef123456'

function authorizeParams(overrides: Record<string, string | undefined> = {}) {
	const params: Record<string, string | undefined> = {
		response_type: 'code',
		client_id: MCP_OAUTH_CLAUDE_CLIENT_ID,
		redirect_uri: REDIRECT,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: STATE,
		resource: 'https://maskin.test/mcp',
		...overrides,
	}
	return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<
		string,
		string
	>
}

function previewPath(overrides: Record<string, string | undefined> = {}) {
	return `/api/oauth/authorize/preview?${new URLSearchParams(authorizeParams(overrides))}`
}

/** A person, switched on for the flag, on a fresh actor id so the per-person limiter starts empty. */
function setup(options: { actorType?: string; flag?: boolean } = {}) {
	const actorId = randomUUID()
	vi.stubEnv('FF_TESTER_FEATURES', options.flag === false ? '' : 'mcp-oauth-consent')
	vi.stubEnv('FF_TESTER_ACTOR_IDS', actorId)
	_resetFeatureFlagConfig()
	const ctx = createTestApp(oauthRoutes, '/api/oauth', actorId, options.actorType ?? 'human')
	return { actorId, ...ctx }
}

beforeEach(() => {
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	vi.stubEnv('MASKIN_OAUTH_ISSUER', 'https://maskin.test')
	capturePosthogEvent.mockClear()
})

afterEach(() => {
	vi.unstubAllEnvs()
	_resetFeatureFlagConfig()
})

describe('GET /api/oauth/authorize/preview', () => {
	it('returns the client, the workspaces with their role and the scope', async () => {
		const { app, mockResults } = setup()
		mockResults.select = [{ id: randomUUID(), name: 'Acme', role: 'viewer' }]

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.client).toEqual({
			client_id: MCP_OAUTH_CLAUDE_CLIENT_ID,
			client_name: 'Claude',
			redirect_host: 'claude.ai',
		})
		expect(body.workspaces).toEqual([expect.objectContaining({ name: 'Acme', role: 'viewer' })])
		expect(body.scope).toBe('mcp')
		expect(Object.keys(body).sort()).toEqual(['client', 'scope', 'workspaces'])
		expect(res.headers.get('Cache-Control')).toBe('no-store')
	})

	it('answers 404 when the env switch is off', async () => {
		const { app } = setup()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(404)
	})

	it('answers 403 access_denied when the flag is off for the person', async () => {
		const { app } = setup({ flag: false })

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(403)
		expect((await res.json()).error).toBe('access_denied')
	})

	it('answers 403 access_denied for an agent actor even with the flag on', async () => {
		const { app } = setup({ actorType: 'agent' })

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(403)
		expect((await res.json()).error).toBe('access_denied')
	})

	it('answers the env switch before the flag: 404 for an agent when the switch is off', async () => {
		const { app } = setup({ actorType: 'agent' })
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(404)
	})

	it.each([
		['client_not_allowlisted', { client_id: 'https://evil.example/c.json' }],
		['bad_redirect_uri', { redirect_uri: 'https://evil.example/cb' }],
		['pkce_missing', { code_challenge: undefined }],
		['invalid_request', { code_challenge_method: 'plain' }],
		['unsupported_response_type', { response_type: 'token' }],
		['invalid_scope', { scope: 'admin' }],
		['invalid_target', { resource: 'https://other.example/mcp' }],
	])('answers 400 %s', async (code, overrides) => {
		const { app } = setup()

		const res = await app.request(jsonGet(previewPath(overrides)))

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error).toBe(code)
		expect(typeof body.error_description).toBe('string')
	})

	it('carries redirect_url on request-shape codes only, and leaves the field out otherwise', async () => {
		const { app } = setup()

		const shape = await (
			await app.request(jsonGet(previewPath({ code_challenge: undefined })))
		).json()
		const identity = await (
			await app.request(jsonGet(previewPath({ client_id: 'https://evil.example/c.json' })))
		).json()

		const link = new URL(shape.redirect_url)
		expect(`${link.origin}${link.pathname}`).toBe(REDIRECT)
		expect(link.searchParams.get('error')).toBe('invalid_request')
		expect(Object.hasOwn(identity, 'redirect_url')).toBe(false)
	})

	it('answers 429 after 30 calls from one person in a minute', async () => {
		const { app, mockResults } = setup()
		mockResults.select = []
		for (let i = 0; i < 30; i++) {
			expect((await app.request(jsonGet(previewPath()))).status).toBe(200)
		}

		const res = await app.request(jsonGet(previewPath()))

		expect(res.status).toBe(429)
		expect(res.headers.get('Retry-After')).toBe('60')
		expect(capturePosthogEvent.mock.calls.at(-1)).toEqual([
			'mcp_oauth_preview_rejected',
			expect.any(String),
			{ client: 'claude_ai', reason: 'rate_limited' },
		])
	})

	it('sends authorize_started with the actor, the client and a workspace count', async () => {
		const { app, actorId, mockResults } = setup()
		mockResults.select = [{ id: randomUUID(), name: 'Acme', role: 'owner' }]

		await app.request(jsonGet(previewPath()))

		expect(capturePosthogEvent).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = capturePosthogEvent.mock.calls[0]
		expect(event).toBe('mcp_oauth_authorize_started')
		expect(distinctId).toBe(actorId)
		expect(props).toEqual({ client: 'claude_ai', workspace_count: 1 })
		const serialized = JSON.stringify(props)
		for (const secret of [STATE, CHALLENGE, REDIRECT]) expect(serialized).not.toContain(secret)
	})

	it('sends preview_rejected with only the reason code, and the client once it matched the pin', async () => {
		const { app, actorId } = setup()

		await app.request(jsonGet(previewPath({ code_challenge: undefined })))
		await app.request(jsonGet(previewPath({ client_id: 'https://evil.example/c.json' })))

		const [first, second] = capturePosthogEvent.mock.calls
		expect(first).toEqual([
			'mcp_oauth_preview_rejected',
			actorId,
			{ client: 'claude_ai', reason: 'pkce_missing' },
		])
		expect(second).toEqual([
			'mcp_oauth_preview_rejected',
			actorId,
			{ reason: 'client_not_allowlisted' },
		])
		expect(JSON.stringify([first, second])).not.toContain(STATE)
	})

	it('sends no event when the switch or the flag turns the person away', async () => {
		const flagOff = setup({ flag: false })
		await flagOff.app.request(jsonGet(previewPath()))
		const switchOff = setup()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		await switchOff.app.request(jsonGet(previewPath()))

		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})
})

describe('POST /api/oauth/authorize/approve', () => {
	const approveBody = (overrides: Record<string, string | undefined> = {}) => ({
		...authorizeParams(overrides),
		workspace_id: randomUUID(),
	})

	it('creates the grant, stores the code as a hash and returns the redirect with code, state and iss', async () => {
		const { app, mockResults, calls, actorId } = setup()
		const grantId = randomUUID()
		mockResults.selectQueue = [
			[buildWorkspaceMember({ actorId })], // membership of the chosen workspace
			[], // no live grant to replace
		]
		mockResults.insert = [{ id: grantId }]
		const body = approveBody()

		const res = await app.request(jsonRequest('POST', '/api/oauth/authorize/approve', body))

		expect(res.status).toBe(200)
		expect(capturePosthogEvent).toHaveBeenCalledWith('mcp_oauth_consent_approved', actorId, {
			client: 'claude_ai',
			workspace_id: body.workspace_id,
			grant_id: grantId,
		})
		const { redirect_url } = await res.json()
		const url = new URL(redirect_url)
		expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
		expect(url.searchParams.get('state')).toBe(STATE)
		expect(url.searchParams.get('iss')).toBe('https://maskin.test')
		const code = url.searchParams.get('code') ?? ''
		expect(code).toHaveLength(43)

		const stored = JSON.stringify(calls.inserts)
		expect(stored).toContain(sha256Hex(code))
		expect(stored).not.toContain(code)
		expect(calls.inserts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: 'oauth_grant_created', entityType: 'oauth_grant' }),
			]),
		)
		expect(res.headers.get('Cache-Control')).toBe('no-store')
	})

	it('answers 404 when the person is not a member of the chosen workspace', async () => {
		const { app, mockResults, calls } = setup()
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest('POST', '/api/oauth/authorize/approve', approveBody()),
		)

		expect(res.status).toBe(404)
		expect(calls.inserts).toHaveLength(0)
		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('answers 400 with the shape code and writes nothing when the request is incomplete', async () => {
		const { app, calls } = setup()

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/oauth/authorize/approve',
				approveBody({ code_challenge: undefined }),
			),
		)

		expect(res.status).toBe(400)
		expect((await res.json()).error).toBe('pkce_missing')
		expect(calls.inserts).toHaveLength(0)
	})

	it('answers 403 access_denied with the flag off and 404 with the switch off', async () => {
		const off = setup({ flag: false })
		const flagOff = await off.app.request(
			jsonRequest('POST', '/api/oauth/authorize/approve', approveBody()),
		)
		const on = setup()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		const switchOff = await on.app.request(
			jsonRequest('POST', '/api/oauth/authorize/approve', approveBody()),
		)

		expect(flagOff.status).toBe(403)
		expect(switchOff.status).toBe(404)
	})

	it('answers 400 for a body without a workspace_id', async () => {
		const { app } = setup()

		const res = await app.request(
			jsonRequest('POST', '/api/oauth/authorize/approve', authorizeParams()),
		)

		expect(res.status).toBe(400)
	})
})

describe('POST /api/oauth/authorize/deny', () => {
	it('returns the access_denied redirect and writes no database rows', async () => {
		const { app, calls, actorId } = setup()

		const res = await app.request(
			jsonRequest('POST', '/api/oauth/authorize/deny', authorizeParams()),
		)

		expect(res.status).toBe(200)
		const url = new URL((await res.json()).redirect_url)
		expect(url.searchParams.get('error')).toBe('access_denied')
		expect(url.searchParams.get('state')).toBe(STATE)
		expect(url.searchParams.get('iss')).toBe('https://maskin.test')
		expect(url.searchParams.has('code')).toBe(false)
		expect(calls.inserts).toHaveLength(0)
		expect(calls.updates).toHaveLength(0)
		expect(capturePosthogEvent).toHaveBeenCalledWith('mcp_oauth_consent_denied', actorId, {
			client: 'claude_ai',
		})
	})

	it('names the picked workspace in the event only when the person is a member of it', async () => {
		const member = setup()
		const workspaceId = randomUUID()
		member.mockResults.selectQueue = [[buildWorkspaceMember({ actorId: member.actorId })]]
		await member.app.request(
			jsonRequest('POST', '/api/oauth/authorize/deny', {
				...authorizeParams(),
				workspace_id: workspaceId,
			}),
		)
		const stranger = setup()
		stranger.mockResults.selectQueue = [[]]
		await stranger.app.request(
			jsonRequest('POST', '/api/oauth/authorize/deny', {
				...authorizeParams(),
				workspace_id: randomUUID(),
			}),
		)

		expect(capturePosthogEvent.mock.calls[0][2]).toEqual({
			client: 'claude_ai',
			workspace_id: workspaceId,
		})
		expect(capturePosthogEvent.mock.calls[1][2]).toEqual({ client: 'claude_ai' })
	})

	it('answers 400 for a request that is not valid, with no redirect to a stranger', async () => {
		const { app } = setup()

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/oauth/authorize/deny',
				authorizeParams({ redirect_uri: 'https://evil.example/cb' }),
			),
		)

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error).toBe('bad_redirect_uri')
		expect(Object.hasOwn(body, 'redirect_url')).toBe(false)
	})
})

describe('connections list and disconnect', () => {
	it('lists with the flag off and the env switch off: they are not behind either', async () => {
		const { app, mockResults } = setup({ flag: false })
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		mockResults.select = []

		const res = await app.request(jsonGet('/api/oauth/grants'))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it("answers 404 when disconnecting a connection that is not the caller's own", async () => {
		const { app, mockResults } = setup({ flag: false })
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		mockResults.select = []

		const res = await app.request(
			new Request(`http://localhost/api/oauth/grants/${randomUUID()}`, { method: 'DELETE' }),
		)

		expect(res.status).toBe(404)
	})
})
