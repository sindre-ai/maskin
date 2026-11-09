// The Claude connector sign-in end to end, on real Postgres and the real app: the person
// previews and approves with their own API key, Claude trades the code for tokens, the access
// token works on /mcp, refresh rotates, reuse ends the connection, and the person can list and
// disconnect. Only PostHog capture is stubbed, so the events can be read back.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { MCP_FORWARD_HEADER, getMcpForwardMarker, sha256Hex } from '@maskin/auth'
import {
	events,
	oauthAuthorizationCodes,
	oauthGrants,
	oauthTokens,
	workspaceMembers,
} from '@maskin/db/schema'
import { PgNotifyBridge } from '@maskin/realtime'
import { and, desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../app-factory'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { logger } from '../../lib/logger'
import { OAuthSweeper } from '../../services/oauth-sweeper'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

const { capturePosthogEvent } = vi.hoisted(() => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent,
}))

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const ISSUER = 'https://maskin.test'
const RESOURCE = `${ISSUER}/mcp`
const STATE = 'state-integration-1234'
const DAY_MS = 86_400_000

let base: string
let closeServer: () => void
const priorPort = process.env.PORT

beforeAll(async () => {
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	vi.stubEnv('MASKIN_OAUTH_ISSUER', ISSUER)
	const app = createApp(
		{
			db,
			notifyBridge: {} as never,
			sessionManager: { stopSession: async () => {}, createSession: async () => ({}) } as never,
			agentStorage: {} as never,
			storageProvider: {} as never,
		},
		{ includeExtensions: false },
	)
	const server = serve({ fetch: app.fetch, port: 0 })
	await new Promise((resolve) => server.once('listening', resolve))
	const { port } = server.address() as { port: number }
	// routes/mcp.ts points the in-process MCP server at http://localhost:$PORT.
	process.env.PORT = String(port)
	base = `http://localhost:${port}`
	closeServer = () => server.close()
}, 60_000)

afterAll(() => {
	closeServer?.()
	vi.unstubAllEnvs()
	if (priorPort === undefined) Reflect.deleteProperty(process.env, 'PORT')
	else process.env.PORT = priorPort
})

beforeEach(() => {
	capturePosthogEvent.mockClear()
})

afterEach(() => {
	// Each test sets what it needs; the switch stays on between tests.
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	vi.stubEnv('FF_TESTER_FEATURES', '')
	vi.stubEnv('FF_TESTER_ACTOR_IDS', '')
	_resetFeatureFlagConfig()
	vi.restoreAllMocks()
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Puts the people on the tester list for mcp-oauth-consent. */
function enableFlagFor(...people: Array<{ id: string }>) {
	vi.stubEnv('FF_TESTER_FEATURES', 'mcp-oauth-consent')
	vi.stubEnv('FF_TESTER_ACTOR_IDS', people.map((p) => p.id).join(','))
	_resetFeatureFlagConfig()
}

function newPkce() {
	const verifier = randomBytes(32).toString('base64url')
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	return { verifier, challenge }
}

function authorizeParams(challenge: string) {
	return {
		response_type: 'code',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state: STATE,
		resource: RESOURCE,
	}
}

interface CallOptions {
	/** The person's API key. */
	key?: string
	/** A Claude access token, sent the way the /mcp forwarder sends it. */
	token?: string
	method?: string
	json?: unknown
	form?: Record<string, string>
	query?: Record<string, string>
	workspaceId?: string
}

async function call(path: string, opts: CallOptions = {}) {
	const headers: Record<string, string> = {
		// Loopback is a trusted proxy, so this gives every call its own rate-limit bucket.
		'X-Forwarded-For': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
	}
	if (opts.key) headers.Authorization = `Bearer ${opts.key}`
	if (opts.workspaceId) headers['X-Workspace-Id'] = opts.workspaceId
	if (opts.token) {
		headers.Authorization = `Bearer ${opts.token}`
		headers[MCP_FORWARD_HEADER] = getMcpForwardMarker()
	}
	let body: string | undefined
	if (opts.json !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(opts.json)
	} else if (opts.form) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded'
		body = new URLSearchParams(opts.form).toString()
	}
	const query = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
	const res = await fetch(`${base}${path}${query}`, {
		method: opts.method ?? (body ? 'POST' : 'GET'),
		headers,
		body,
	})
	const text = await res.text()
	let parsed: unknown = text
	try {
		parsed = JSON.parse(text)
	} catch {}
	// biome-ignore lint/suspicious/noExplicitAny: parsed JSON, shape asserted per test
	return { status: res.status, body: parsed as any, text, headers: res.headers }
}

async function mcpRpc(token: string, method: string, params: Record<string, unknown> = {}) {
	const res = await fetch(`${base}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	})
	const raw = await res.text()
	let json: unknown = null
	try {
		json = JSON.parse(raw)
	} catch {}
	// biome-ignore lint/suspicious/noExplicitAny: parsed JSON, shape asserted per test
	return { status: res.status, json: json as any, raw }
}

type Person = Awaited<ReturnType<typeof insertActor>>
type Workspace = Awaited<ReturnType<typeof insertWorkspace>>

function tokenExchange(code: string, verifier: string) {
	return call('/oauth/token', {
		form: {
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT,
			code_verifier: verifier,
			client_id: CLIENT_ID,
		},
	})
}

function refreshExchange(refreshToken: string) {
	return call('/oauth/token', {
		form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
	})
}

/** Approve, then trade the code: what a person and Claude do together. */
async function connect(person: Person, workspace: Workspace) {
	const { verifier, challenge } = newPkce()
	const approve = await call('/api/oauth/authorize/approve', {
		key: person.apiKey,
		json: { ...authorizeParams(challenge), workspace_id: workspace.id },
	})
	expect(approve.status).toBe(200)
	const code = new URL(approve.body.redirect_url).searchParams.get('code') as string
	const token = await tokenExchange(code, verifier)
	expect(token.status).toBe(200)
	return {
		code,
		verifier,
		approve,
		token,
		access: token.body.access_token as string,
		refresh: token.body.refresh_token as string,
	}
}

async function latestGrant(person: Person, workspace: Workspace) {
	const [grant] = await db
		.select()
		.from(oauthGrants)
		.where(and(eq(oauthGrants.actorId, person.id), eq(oauthGrants.workspaceId, workspace.id)))
		.orderBy(desc(oauthGrants.createdAt))
		.limit(1)
	return grant
}

async function grantEvents(grantId: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.entityType, 'oauth_grant'), eq(events.entityId, grantId)))
		.orderBy(events.id)
}

async function pollFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	let value = await read()
	while (!value && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50))
		value = await read()
	}
	return value
}

async function seedPerson(options: { tester?: boolean } = {}) {
	const person = await insertActor(db)
	const workspace = await insertWorkspace(db, person.id)
	if (options.tester !== false) enableFlagFor(person)
	return { person, workspace }
}

// ── the whole path ───────────────────────────────────────────────────────────

describe('preview, approve, token, then an authenticated call', () => {
	it('connects Claude and the new access token works on /mcp', async () => {
		const { person, workspace } = await seedPerson()
		const { verifier, challenge } = newPkce()

		const preview = await call('/api/oauth/authorize/preview', {
			key: person.apiKey,
			query: authorizeParams(challenge),
		})
		expect(preview.status).toBe(200)
		expect(preview.body.client).toEqual({
			client_id: CLIENT_ID,
			client_name: 'Claude',
			redirect_host: 'claude.ai',
		})
		expect(preview.body.workspaces).toContainEqual({
			id: workspace.id,
			name: workspace.name,
			role: 'owner',
		})

		const approve = await call('/api/oauth/authorize/approve', {
			key: person.apiKey,
			json: {
				...authorizeParams(challenge),
				workspace_id: workspace.id,
			},
		})
		expect(approve.status).toBe(200)
		const redirect = new URL(approve.body.redirect_url)
		expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
		expect(redirect.searchParams.get('state')).toBe(STATE)
		expect(redirect.searchParams.get('iss')).toBe(ISSUER)

		const code = redirect.searchParams.get('code') as string
		const token = await tokenExchange(code, verifier)
		expect(token.status).toBe(200)
		expect(token.headers.get('Cache-Control')).toBe('no-store')
		expect(token.headers.get('Pragma')).toBe('no-cache')
		expect(token.body).toEqual({
			access_token: expect.stringMatching(/^mat_[A-Za-z0-9_-]{43}$/),
			token_type: 'Bearer',
			expires_in: 3600,
			refresh_token: expect.stringMatching(/^mrt_[A-Za-z0-9_-]{43}$/),
			scope: 'mcp',
		})

		const tools = await mcpRpc(token.body.access_token, 'tools/list')
		expect(tools.status).toBe(200)
		expect(tools.json.result.tools.length).toBeGreaterThan(0)

		const grant = await latestGrant(person, workspace)
		expect(grant.revokedAt).toBeNull()
		expect(grant.resource).toBe(RESOURCE)
		const names = (await grantEvents(grant.id)).map((e) => e.action)
		expect(names).toEqual(['oauth_grant_created', 'oauth_token_issued'])
	})

	it('sends all 8 events from the real code paths, with a closed set of properties and no secret', async () => {
		const { person, workspace } = await seedPerson()
		const first = await connect(person, workspace)
		const firstGrant = await latestGrant(person, workspace)
		const refreshed = await refreshExchange(first.refresh)
		// The same code again: ends the connection and is refused.
		await tokenExchange(first.code, first.verifier)
		// A code nobody issued: no grant resolves.
		await tokenExchange(randomBytes(32).toString('base64url'), newPkce().verifier)
		// A second connection, rotated once, then the old refresh token comes back.
		const second = await connect(person, workspace)
		const secondGrant = await latestGrant(person, workspace)
		await refreshExchange(second.refresh)
		await refreshExchange(second.refresh)
		const { challenge } = newPkce()
		await call('/api/oauth/authorize/preview', {
			key: person.apiKey,
			query: authorizeParams(challenge),
		})
		await call('/api/oauth/authorize/preview', {
			key: person.apiKey,
			query: { ...authorizeParams(challenge), code_challenge: '' },
		})
		await call('/api/oauth/authorize/deny', {
			key: person.apiKey,
			json: { ...authorizeParams(challenge), workspace_id: workspace.id },
		})

		const sent = capturePosthogEvent.mock.calls.filter(([name]) => /^(mcp_)?oauth_/.test(name))
		const named = (name: string) => sent.filter(([sentName]) => sentName === name)
		expect([...new Set(sent.map(([name]) => name))].sort()).toEqual([
			'mcp_oauth_authorize_started',
			'mcp_oauth_consent_approved',
			'mcp_oauth_consent_denied',
			'mcp_oauth_preview_rejected',
			'mcp_oauth_token_issued',
			'mcp_oauth_token_refreshed',
			'mcp_oauth_token_rejected',
			'oauth_refresh_reuse_revoked',
		])
		expect(named('mcp_oauth_authorize_started')[0].slice(1)).toEqual([
			person.id,
			{ client: 'claude_ai', workspace_count: expect.any(Number) },
		])
		expect(named('mcp_oauth_preview_rejected')[0].slice(1)).toEqual([
			person.id,
			{ client: 'claude_ai', reason: 'pkce_missing' },
		])
		expect(named('mcp_oauth_consent_approved')[0].slice(1)).toEqual([
			person.id,
			{ client: 'claude_ai', workspace_id: workspace.id, grant_id: firstGrant.id },
		])
		expect(named('mcp_oauth_consent_denied')[0].slice(1)).toEqual([
			person.id,
			{ client: 'claude_ai', workspace_id: workspace.id },
		])
		expect(named('mcp_oauth_token_issued')[0].slice(1)).toEqual([
			person.id,
			{
				client: 'claude_ai',
				workspace_id: workspace.id,
				grant_id: firstGrant.id,
				grant_type: 'authorization_code',
			},
		])
		expect(named('mcp_oauth_token_refreshed')[0].slice(1)).toEqual([
			person.id,
			{ client: 'claude_ai', workspace_id: workspace.id, grant_id: firstGrant.id },
		])
		const rejections = named('mcp_oauth_token_rejected').map(([, id, props]) => [id, props])
		expect(rejections).toEqual(
			expect.arrayContaining([
				[person.id, { client: 'claude_ai', reason: 'code_reuse', grant_id: firstGrant.id }],
				[
					'oauth-unresolved',
					{
						client: 'claude_ai',
						reason: 'code_unknown_or_expired',
						$process_person_profile: false,
					},
				],
			]),
		)
		expect(named('oauth_refresh_reuse_revoked')[0].slice(1)).toEqual([
			person.id,
			{
				client: 'claude_ai',
				grant_id: secondGrant.id,
				grant_age_s: expect.any(Number),
				seconds_since_first_use: expect.any(Number),
			},
		])

		const everything = JSON.stringify(sent)
		for (const secret of [
			first.access,
			first.refresh,
			first.code,
			first.verifier,
			refreshed.body.access_token,
			refreshed.body.refresh_token,
			second.access,
			second.refresh,
			second.code,
			STATE,
			challenge,
			REDIRECT,
		]) {
			expect(everything).not.toContain(secret)
		}
	})

	it('answers 404 on preview and the token endpoint when the env switch is off', async () => {
		const { person } = await seedPerson()
		const { challenge } = newPkce()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

		const preview = await call('/api/oauth/authorize/preview', {
			key: person.apiKey,
			query: authorizeParams(challenge),
		})
		const token = await call('/oauth/token', { form: { grant_type: 'refresh_token' } })

		expect(preview.status).toBe(404)
		expect(token.status).toBe(404)
	})

	it('answers 403 access_denied when the flag is off for the person', async () => {
		const { person } = await seedPerson({ tester: false })
		const { challenge } = newPkce()

		const preview = await call('/api/oauth/authorize/preview', {
			key: person.apiKey,
			query: authorizeParams(challenge),
		})

		expect(preview.status).toBe(403)
		expect(preview.body.error).toBe('access_denied')
	})

	it('answers 403 access_denied for an agent actor', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		enableFlagFor(agent)
		const { challenge } = newPkce()

		const preview = await call('/api/oauth/authorize/preview', {
			key: agent.apiKey,
			query: authorizeParams(challenge),
		})

		expect(preview.status).toBe(403)
		expect(preview.body.error).toBe('access_denied')
	})

	it('answers 403 for a Claude access token on every /api/oauth route', async () => {
		const { person, workspace } = await seedPerson()
		const { access } = await connect(person, workspace)
		const { challenge } = newPkce()

		const list = await call('/api/oauth/grants', { token: access })
		const approve = await call('/api/oauth/authorize/approve', {
			token: access,
			json: { ...authorizeParams(challenge), workspace_id: workspace.id },
		})

		expect(list.status).toBe(403)
		expect(list.body.error.oauth_error).toBe('insufficient_scope')
		expect(approve.status).toBe(403)
	})

	it('replaces the old connection when the same person approves the same workspace again', async () => {
		const { person, workspace } = await seedPerson()
		const first = await connect(person, workspace)
		const firstGrant = await latestGrant(person, workspace)

		const second = await connect(person, workspace)

		const grants = await db.select().from(oauthGrants).where(eq(oauthGrants.actorId, person.id))
		const live = grants.filter((g) => g.revokedAt === null)
		expect(live).toHaveLength(1)
		expect(live[0].id).not.toBe(firstGrant.id)
		expect(grants.find((g) => g.id === firstGrant.id)?.revokeReason).toBe('user')
		expect((await mcpRpc(first.access, 'tools/list')).status).toBe(401)
		expect((await mcpRpc(second.access, 'tools/list')).status).toBe(200)
		const list = await call('/api/oauth/grants', { key: person.apiKey })
		expect(list.body.map((g: { id: string }) => g.id)).toEqual([live[0].id])
	})
})

// ── the code ─────────────────────────────────────────────────────────────────

describe('the one-time code', () => {
	it('lets exactly one of two simultaneous presentations win', async () => {
		const { person, workspace } = await seedPerson()
		const { verifier, challenge } = newPkce()
		const approve = await call('/api/oauth/authorize/approve', {
			key: person.apiKey,
			json: { ...authorizeParams(challenge), workspace_id: workspace.id },
		})
		const code = new URL(approve.body.redirect_url).searchParams.get('code') as string

		const results = await Promise.all([
			tokenExchange(code, verifier),
			tokenExchange(code, verifier),
		])

		expect(results.map((r) => r.status).sort()).toEqual([200, 400])
	})

	it('ends the connection when a used code is presented again', async () => {
		const { person, workspace } = await seedPerson()
		const { code, verifier, access } = await connect(person, workspace)

		const replay = await tokenExchange(code, verifier)

		expect(replay.status).toBe(400)
		expect(replay.body.error).toBe('invalid_grant')
		const grant = await latestGrant(person, workspace)
		expect(grant.revokedAt).not.toBeNull()
		expect(grant.revokeReason).toBe('code_reuse')
		expect((await mcpRpc(access, 'tools/list')).status).toBe(401)
		const actions = (await grantEvents(grant.id)).map((e) => e.action)
		expect(actions).toContain('oauth_code_reuse_detected')
		expect(actions).toContain('oauth_grant_revoked')
	})

	it('ends the connection when the PKCE verifier is wrong', async () => {
		const { person, workspace } = await seedPerson()
		const { challenge } = newPkce()
		const approve = await call('/api/oauth/authorize/approve', {
			key: person.apiKey,
			json: { ...authorizeParams(challenge), workspace_id: workspace.id },
		})
		const code = new URL(approve.body.redirect_url).searchParams.get('code') as string

		const res = await tokenExchange(code, newPkce().verifier)

		expect(res.status).toBe(400)
		expect(res.body.error).toBe('invalid_grant')
		const grant = await latestGrant(person, workspace)
		expect(grant.revokeReason).toBe('pkce_failure')
	})

	it('refuses a code from a different redirect address, an unknown client and a bad grant type', async () => {
		const { person, workspace } = await seedPerson()
		const { verifier, challenge } = newPkce()
		const approve = await call('/api/oauth/authorize/approve', {
			key: person.apiKey,
			json: { ...authorizeParams(challenge), workspace_id: workspace.id },
		})
		const code = new URL(approve.body.redirect_url).searchParams.get('code') as string

		const unknownClient = await call('/oauth/token', {
			form: {
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT,
				code_verifier: verifier,
				client_id: 'https://evil.example/client.json',
			},
		})
		const badGrantType = await call('/oauth/token', { form: { grant_type: 'password' } })
		const wrongRedirect = await call('/oauth/token', {
			form: {
				grant_type: 'authorization_code',
				code,
				redirect_uri: 'https://claude.ai/api/mcp/other',
				code_verifier: verifier,
				client_id: CLIENT_ID,
			},
		})

		expect(unknownClient.body.error).toBe('invalid_client')
		expect(badGrantType.body.error).toBe('unsupported_grant_type')
		expect(wrongRedirect.status).toBe(400)
		expect(wrongRedirect.body.error).toBe('invalid_grant')
		expect(JSON.stringify([unknownClient.body, wrongRedirect.body])).not.toContain(code)
	})
})

// ── refresh ──────────────────────────────────────────────────────────────────

describe('refresh tokens', () => {
	it('rotates: a new pair, the old refresh token marked used and linked to the new one', async () => {
		const { person, workspace } = await seedPerson()
		const { access, refresh } = await connect(person, workspace)

		const res = await refreshExchange(refresh)

		expect(res.status).toBe(200)
		expect(res.body.refresh_token).not.toBe(refresh)
		expect(res.body.access_token).not.toBe(access)
		const [oldRow] = await db
			.select()
			.from(oauthTokens)
			.where(eq(oauthTokens.tokenHash, sha256Hex(refresh)))
		const [newRow] = await db
			.select()
			.from(oauthTokens)
			.where(eq(oauthTokens.tokenHash, sha256Hex(res.body.refresh_token)))
		expect(oldRow.usedAt).not.toBeNull()
		expect(oldRow.replacedBy).toBe(newRow.id)
		expect(newRow.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS)
		expect((await mcpRpc(res.body.access_token, 'tools/list')).status).toBe(200)
		expect((await latestGrant(person, workspace)).revokedAt).toBeNull()
	})

	it('ends the connection on reuse, with no grace, and counts it', async () => {
		const { person, workspace } = await seedPerson()
		const { refresh } = await connect(person, workspace)
		const rotated = await refreshExchange(refresh)
		expect(rotated.status).toBe(200)

		const reuse = await refreshExchange(refresh)

		expect(reuse.status).toBe(400)
		expect(reuse.body.error).toBe('invalid_grant')
		const grant = await latestGrant(person, workspace)
		expect(grant.revokeReason).toBe('refresh_reuse')
		expect((await mcpRpc(rotated.body.access_token, 'tools/list')).status).toBe(401)
		expect((await refreshExchange(rotated.body.refresh_token)).status).toBe(400)
		const actions = (await grantEvents(grant.id)).map((e) => e.action)
		expect(actions).toContain('oauth_refresh_reuse_detected')

		const counted = capturePosthogEvent.mock.calls.filter(
			([name]) => name === 'oauth_refresh_reuse_revoked',
		)
		expect(counted).toHaveLength(1)
		expect(counted[0][1]).toBe(person.id)
		expect(counted[0][2]).toEqual({
			client: 'claude_ai',
			grant_age_s: expect.any(Number),
			grant_id: grant.id,
			seconds_since_first_use: expect.any(Number),
		})
		expect(JSON.stringify(counted)).not.toContain(refresh)
	})

	it('refuses an expired refresh token and a different client', async () => {
		const { person, workspace } = await seedPerson()
		const { refresh } = await connect(person, workspace)

		const otherClient = await call('/oauth/token', {
			form: {
				grant_type: 'refresh_token',
				refresh_token: refresh,
				client_id: 'https://evil.example/client.json',
			},
		})
		await db
			.update(oauthTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(oauthTokens.tokenHash, sha256Hex(refresh)))
		const expired = await refreshExchange(refresh)

		expect(otherClient.body.error).toBe('invalid_client')
		expect(expired.status).toBe(400)
		expect(expired.body.error).toBe('invalid_grant')
	})
})

// ── list and disconnect ──────────────────────────────────────────────────────

describe('GET /api/oauth/grants and DELETE /api/oauth/grants/:id', () => {
	it('agrees with the token step on live, revoked, idle past 30 days and member removed', async () => {
		const person = await insertActor(db)
		enableFlagFor(person)
		const live = await insertWorkspace(db, person.id, { name: 'Live workspace' })
		const revoked = await insertWorkspace(db, person.id, { name: 'Revoked workspace' })
		const idle = await insertWorkspace(db, person.id, { name: 'Idle workspace' })
		const removed = await insertWorkspace(db, person.id, { name: 'Removed workspace' })
		const connections = {
			live: await connect(person, live),
			revoked: await connect(person, revoked),
			idle: await connect(person, idle),
			removed: await connect(person, removed),
		}
		const revokedGrant = await latestGrant(person, revoked)
		const disconnect = await call(`/api/oauth/grants/${revokedGrant.id}`, {
			key: person.apiKey,
			method: 'DELETE',
		})
		expect(disconnect.status).toBe(200)
		// 31 days idle: the refresh token was issued a month ago and never used again.
		await db
			.update(oauthTokens)
			.set({ expiresAt: new Date(Date.now() - DAY_MS) })
			.where(eq(oauthTokens.tokenHash, sha256Hex(connections.idle.refresh)))
		// Removed straight from the table, so the grant itself is still marked live.
		await db
			.delete(workspaceMembers)
			.where(
				and(eq(workspaceMembers.actorId, person.id), eq(workspaceMembers.workspaceId, removed.id)),
			)

		const list = await call('/api/oauth/grants', { key: person.apiKey })

		expect(list.status).toBe(200)
		const listedWorkspaces = list.body.map((g: { workspace_id: string }) => g.workspace_id)
		const outcomes: Record<string, { listed: boolean; refreshed: boolean }> = {}
		for (const [name, ws] of Object.entries({ live, revoked, idle, removed })) {
			const refreshed = await refreshExchange(connections[name as keyof typeof connections].refresh)
			outcomes[name] = {
				listed: listedWorkspaces.includes(ws.id),
				refreshed: refreshed.status === 200,
			}
		}
		for (const [name, outcome] of Object.entries(outcomes)) {
			expect(outcome.listed, `${name}: list and token step disagree`).toBe(outcome.refreshed)
		}
		expect(outcomes).toEqual({
			live: { listed: true, refreshed: true },
			revoked: { listed: false, refreshed: false },
			idle: { listed: false, refreshed: false },
			removed: { listed: false, refreshed: false },
		})
		expect(list.body).toHaveLength(1)
		expect(list.body[0]).toMatchObject({
			client_id: CLIENT_ID,
			client_name: 'Claude',
			workspace_id: live.id,
			workspace_name: 'Live workspace',
		})
		expect(list.body[0].workspace_name).not.toBe(live.id)
	})

	it('shows no last-used time before the first tool call, then stamps it at most every 5 minutes', async () => {
		const { person, workspace } = await seedPerson()
		const { access } = await connect(person, workspace)
		const before = await call('/api/oauth/grants', { key: person.apiKey })
		expect(before.body[0].last_used_at).toBeNull()

		const first = await mcpRpc(access, 'tools/call', { name: 'list_workspaces', arguments: {} })
		expect(first.status).toBe(200)
		const stamped = await pollFor(async () => {
			const res = await call('/api/oauth/grants', { key: person.apiKey })
			return res.body[0].last_used_at as string | null
		})
		expect(stamped).not.toBeNull()

		await mcpRpc(access, 'tools/call', { name: 'list_workspaces', arguments: {} })
		await new Promise((resolve) => setTimeout(resolve, 300))
		const after = await call('/api/oauth/grants', { key: person.apiKey })
		expect(after.body[0].last_used_at).toBe(stamped)
	})

	it('lists and disconnects with the flag and the env switch both off', async () => {
		const { person, workspace } = await seedPerson()
		const { access } = await connect(person, workspace)
		const grant = await latestGrant(person, workspace)
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		vi.stubEnv('FF_TESTER_FEATURES', '')
		_resetFeatureFlagConfig()

		const list = await call('/api/oauth/grants', { key: person.apiKey })
		const disconnect = await call(`/api/oauth/grants/${grant.id}`, {
			key: person.apiKey,
			method: 'DELETE',
		})
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		const afterwards = await mcpRpc(access, 'tools/list')

		expect(list.status).toBe(200)
		expect(list.body.map((g: { id: string }) => g.id)).toEqual([grant.id])
		expect(disconnect.status).toBe(200)
		expect(disconnect.body).toEqual({ revoked: true })
		expect(afterwards.status).toBe(401)
		expect((await call('/api/oauth/grants', { key: person.apiKey })).body).toEqual([])
	})

	it("does not let a person disconnect someone else's connection", async () => {
		const { person, workspace } = await seedPerson()
		await connect(person, workspace)
		const grant = await latestGrant(person, workspace)
		const stranger = await insertActor(db)

		const res = await call(`/api/oauth/grants/${grant.id}`, {
			key: stranger.apiKey,
			method: 'DELETE',
		})

		expect(res.status).toBe(404)
		expect((await latestGrant(person, workspace)).revokedAt).toBeNull()
	})
})

// ── a member leaves ──────────────────────────────────────────────────────────

describe('removing a member', () => {
	it("ends that person's connections to the workspace", async () => {
		const owner = await insertActor(db)
		const workspace = await insertWorkspace(db, owner.id)
		const member = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: workspace.id, actorId: member.id, role: 'member' })
		enableFlagFor(member)
		const { access } = await connect(member, workspace)
		const grant = await latestGrant(member, workspace)

		const removal = await call(`/api/workspaces/${workspace.id}/members/${member.id}`, {
			key: owner.apiKey,
			method: 'DELETE',
		})

		expect(removal.status).toBe(200)
		const ended = await latestGrant(member, workspace)
		expect(ended.revokedAt).not.toBeNull()
		expect(ended.revokeReason).toBe('member_removed')
		expect((await mcpRpc(access, 'tools/list')).status).toBe(401)
		expect((await call('/api/oauth/grants', { key: member.apiKey })).body).toEqual([])
		const revoked = (await grantEvents(grant.id)).find((e) => e.action === 'oauth_grant_revoked')
		expect(revoked?.data).toMatchObject({ reason: 'member_removed' })
	})
})

// ── nothing secret is stored, and the rest of the system copes ───────────────

describe('what is stored and what reads it', () => {
	it('keeps no mat_, mrt_ or code value in any column or in events.data', async () => {
		const { person, workspace } = await seedPerson()
		const { code, verifier, access, refresh } = await connect(person, workspace)
		const rotated = await refreshExchange(refresh)
		await refreshExchange(refresh)

		const stored = JSON.stringify({
			grants: await db.select().from(oauthGrants),
			codes: await db.select().from(oauthAuthorizationCodes),
			tokens: await db.select().from(oauthTokens),
			events: await db.select().from(events).where(eq(events.entityType, 'oauth_grant')),
		})

		for (const secret of [
			code,
			verifier,
			access,
			refresh,
			rotated.body.access_token,
			rotated.body.refresh_token,
		]) {
			expect(stored).not.toContain(secret)
		}
		expect(stored).not.toMatch(/\b(?:mat|mrt)_[A-Za-z0-9_-]{16,}/)
		const [codeRow] = await db
			.select()
			.from(oauthAuthorizationCodes)
			.where(eq(oauthAuthorizationCodes.codeHash, sha256Hex(code)))
		expect(codeRow.consumedAt).not.toBeNull()
	})

	it('lets the SSE bridge and the trigger runner see oauth_grant events without an error', async () => {
		const databaseUrl = process.env.DATABASE_URL as string
		const bridge = new PgNotifyBridge(databaseUrl)
		await bridge.start()
		const seen: Array<{ action: string; entity_type: string }> = []
		bridge.on('event', (event) => seen.push(event))
		const runner = new TriggerRunner(db, bridge, {} as never)
		await runner.start()
		const errors = vi.spyOn(logger, 'error')
		try {
			const { person, workspace } = await seedPerson()
			const { access } = await connect(person, workspace)
			const grant = await latestGrant(person, workspace)
			await call(`/api/oauth/grants/${grant.id}`, { key: person.apiKey, method: 'DELETE' })

			await pollFor(async () =>
				seen.filter((e) => e.entity_type === 'oauth_grant').length >= 3 ? true : null,
			)
			// The runner handles each event asynchronously; give it a moment to finish.
			await new Promise((resolve) => setTimeout(resolve, 300))

			const oauthActions = seen.filter((e) => e.entity_type === 'oauth_grant').map((e) => e.action)
			expect(oauthActions).toEqual(
				expect.arrayContaining([
					'oauth_grant_created',
					'oauth_token_issued',
					'oauth_grant_revoked',
				]),
			)
			// Other tests share the database, so only errors that name this grant or its type count.
			const aboutOauth = errors.mock.calls.filter((args) =>
				/oauth_grant|oauth_/.test(JSON.stringify(args)),
			)
			expect(aboutOauth).toEqual([])
			expect((await mcpRpc(access, 'tools/list')).status).toBe(401)
			const feed = await call('/api/events', {
				key: person.apiKey,
				workspaceId: workspace.id,
				query: { entity_type: 'oauth_grant' },
			})
			expect(feed.status).toBe(200)
		} finally {
			await runner.stop()
			await bridge.stop()
		}
	})
})

describe('the sweeper', () => {
	it('deletes codes expired over a day and tokens expired over a week, and nothing else', async () => {
		const { person, workspace } = await seedPerson()
		const [grant] = await db
			.insert(oauthGrants)
			.values({
				actorId: person.id,
				workspaceId: workspace.id,
				clientId: CLIENT_ID,
				clientName: 'Claude',
				resource: RESOURCE,
			})
			.returning()
		const hash = () => sha256Hex(randomUUID())
		const code = (expiresAt: Date) => {
			const codeHash = hash()
			return db
				.insert(oauthAuthorizationCodes)
				.values({
					codeHash,
					grantId: grant.id,
					redirectUri: REDIRECT,
					codeChallenge: 'c'.repeat(43),
					resource: RESOURCE,
					expiresAt,
				})
				.then(() => codeHash)
		}
		const token = (expiresAt: Date) => {
			const tokenHash = hash()
			return db
				.insert(oauthTokens)
				.values({ grantId: grant.id, kind: 'access', tokenHash, expiresAt })
				.then(() => tokenHash)
		}
		const now = Date.now()
		const oldCode = await code(new Date(now - 2 * DAY_MS))
		const recentCode = await code(new Date(now - 60_000))
		const liveCode = await code(new Date(now + 60_000))
		const oldToken = await token(new Date(now - 8 * DAY_MS))
		const recentToken = await token(new Date(now - 2 * DAY_MS))
		const liveToken = await token(new Date(now + 3_600_000))

		const result = await new OAuthSweeper(db).tick()

		expect(result?.codes).toBeGreaterThanOrEqual(1)
		expect(result?.tokens).toBeGreaterThanOrEqual(1)
		const codesLeft = (await db.select().from(oauthAuthorizationCodes)).map((c) => c.codeHash)
		const tokensLeft = (await db.select().from(oauthTokens)).map((t) => t.tokenHash)
		expect(codesLeft).not.toContain(oldCode)
		expect(codesLeft).toEqual(expect.arrayContaining([recentCode, liveCode]))
		expect(tokensLeft).not.toContain(oldToken)
		expect(tokensLeft).toEqual(expect.arrayContaining([recentToken, liveToken]))
		const [kept] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id))
		expect(kept).toBeDefined()
	})
})
