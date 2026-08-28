import { describe, expect, it, vi } from 'vitest'
import {
	ToolBrokerAuthError,
	ToolBrokerClient,
	ToolBrokerHttpError,
	ToolBrokerPatternError,
	ToolBrokerUnavailableError,
	assertScopedPattern,
	displayNameFromSlug,
	integrationPattern,
	workspacePrefix,
	workspaceScopedSlug,
} from '../index'

const WORKSPACE = '11111111-2222-3333-4444-555555555555'
const OTHER_WORKSPACE = '99999999-8888-7777-6666-555555555555'

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch stub that answers each path with a canned response. */
const stubFetch = (routes: Record<string, () => Response>) => {
	const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const path = new URL(url).pathname
		calls.push({
			url,
			method: init?.method ?? 'GET',
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			auth: new Headers(init?.headers).get('Authorization'),
		})
		const route = Object.entries(routes).find(([key]) => path === key || path.startsWith(key))
		if (!route) return new Response('no route', { status: 404 })
		return route[1]()
	})
	return { impl: impl as unknown as typeof fetch, calls }
}

const makeClient = (impl: typeof fetch) =>
	new ToolBrokerClient({
		baseUrl: 'http://broker.local',
		adminEmail: 'admin@local.test',
		adminPassword: 'admin-password',
		fetchImpl: impl,
	})

describe('workspace namespacing', () => {
	it('derives a fixed-length prefix from the workspace id', () => {
		const prefix = workspacePrefix(WORKSPACE)
		expect(prefix).toBe('w11111111222233334444555555555555_')
		// 'w' + 32 hex + '-'
		expect(prefix).toHaveLength(34)
	})

	// Hygiene, not the security guard. Patterns are segment-aligned and match
	// segments literally, so `ws-1` could never partially match `ws-10` anyway.
	// The fixed-length prefix is kept because it keeps slugs predictable; the
	// load-bearing check is `assertScopedPattern` below.
	it('gives every workspace a same-length, non-overlapping prefix', () => {
		const a = workspacePrefix('11111111-1111-1111-1111-111111111111')
		const b = workspacePrefix('11111111-1111-1111-1111-111111111110')
		expect(a.startsWith(b)).toBe(false)
		expect(b.startsWith(a)).toBe(false)
		expect(a).toHaveLength(b.length)
	})

	it('builds a segment-aligned membership pattern per integration', () => {
		// Verified against a live instance: `<slug>.*` is accepted, `<prefix>*` is
		// rejected as "Invalid toolkit policy pattern" because a wildcard must
		// replace a WHOLE segment. Membership is therefore one row per
		// integration, not one glob per workspace.
		const slug = workspaceScopedSlug(WORKSPACE, 'hubspot')
		expect(integrationPattern(slug)).toBe(`${slug}.*`)
		expect(integrationPattern(slug).split('.').length).toBeGreaterThanOrEqual(2)
	})

	it('round-trips a display name without leaking the prefix', () => {
		const slug = workspaceScopedSlug(WORKSPACE, 'My Linear!')
		expect(slug).toBe(`${workspacePrefix(WORKSPACE)}my_linear`)
		expect(displayNameFromSlug(WORKSPACE, slug)).toBe('my_linear')
	})
})

describe('provisionActor', () => {
	it('signs in as admin, invites, signs up, and mints a key', async () => {
		const { impl, calls } = stubFetch({
			'/api/auth/sign-in/email': () => json({ token: 'admin-session' }),
			'/api/admin/invites': () => json({ code: 'AAAA-BBBB-CCCC' }),
			'/api/auth/sign-up/email': () => json({ token: 'user-session', user: { id: 'subject-1' } }),
			'/api/account/api-keys': () => json({ value: 'the-api-key' }),
		})

		const result = await makeClient(impl).provisionActor({
			email: 'actor@maskin.local',
			displayName: 'Actor',
			generatePassword: () => 'generated-password',
		})

		expect(result).toEqual({ subjectId: 'subject-1', apiKey: 'the-api-key' })

		// The invite must be created with the ADMIN SESSION, and the key with the
		// USER SESSION — the account and admin planes both reject API keys.
		const invite = calls.find((c) => c.url.includes('/admin/invites'))
		expect(invite?.auth).toBe('Bearer admin-session')
		const mint = calls.find((c) => c.url.includes('/account/api-keys'))
		expect(mint?.auth).toBe('Bearer user-session')

		// The signup carries the invite code, or the gate rejects it.
		const signUp = calls.find((c) => c.url.includes('/sign-up/email'))
		expect((signUp?.body as { inviteCode: string }).inviteCode).toBe('AAAA-BBBB-CCCC')
	})

	it('never sends the generated password anywhere except sign-up', async () => {
		const { impl, calls } = stubFetch({
			'/api/auth/sign-in/email': () => json({ token: 'admin-session' }),
			'/api/admin/invites': () => json({ code: 'CODE' }),
			'/api/auth/sign-up/email': () => json({ token: 'user-session', user: { id: 's' } }),
			'/api/account/api-keys': () => json({ value: 'k' }),
		})

		await makeClient(impl).provisionActor({
			email: 'a@b.c',
			displayName: 'A',
			generatePassword: () => 'SECRET-PASSWORD',
		})

		// The password is used once and discarded — it must not appear on the
		// invite call, the key-mint call, or anywhere else.
		const leaked = calls.filter(
			(c) =>
				!c.url.includes('/sign-up/email') &&
				JSON.stringify(c.body ?? '').includes('SECRET-PASSWORD'),
		)
		expect(leaked).toEqual([])
	})
})

describe('ensureToolkit', () => {
	it('reuses an existing toolkit rather than creating a second one', async () => {
		const { impl, calls } = stubFetch({
			'/api/toolkits': () => json({ toolkits: [{ id: 'tk-1', slug: expectedSlug(), name: 'WS' }] }),
		})

		const toolkit = await makeClient(impl).ensureToolkit('key', {
			workspaceId: WORKSPACE,
			name: 'WS',
		})

		expect(toolkit.id).toBe('tk-1')
		// No writes at all: a toolkit that already exists needs nothing, and
		// membership is added per integration, not here.
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
	})

	it('admits a fresh toolkit to nothing', async () => {
		const { impl, calls } = stubFetch({
			'/api/toolkits': () => json({ toolkits: [] }),
		})

		await makeClient(impl).ensureToolkit('key', { workspaceId: WORKSPACE, name: 'WS' })

		// Creating the toolkit must NOT also admit anything. The endpoint is
		// default-deny, so a new workspace starts with zero reachable tools.
		const membership = calls.filter((c) => c.url.includes('/connections'))
		expect(membership).toEqual([])
	})
})

describe('admitIntegration', () => {
	it('writes a segment-aligned pattern scoped to the integration', async () => {
		const { impl, calls } = stubFetch({ '/api/toolkits': () => json({}) })
		const slug = workspaceScopedSlug(WORKSPACE, 'hubspot')

		await makeClient(impl).admitIntegration('key', { toolkitId: 'tk-1', integrationSlug: slug })

		const body = calls.at(-1)?.body as { pattern: string }
		expect(body.pattern).toBe(`${slug}.*`)
	})

	it('refuses to admit an integration whose slug lost its workspace prefix', async () => {
		const { impl, calls } = stubFetch({ '/api/toolkits': () => json({}) })

		// A slug bug that drops the prefix would otherwise write `hubspot.*`,
		// admitting another workspace's HubSpot into this toolkit.
		await expect(
			makeClient(impl).admitIntegration('key', { toolkitId: 'tk-1', integrationSlug: 'hubspot' }),
		).rejects.toBeInstanceOf(ToolBrokerPatternError)
		// And nothing was sent.
		expect(calls).toEqual([])
	})
})

describe('listIntegrations', () => {
	it('returns only this workspace’s integrations and drops built-ins', async () => {
		const mine = workspaceScopedSlug(WORKSPACE, 'linear')
		const theirs = workspaceScopedSlug(OTHER_WORKSPACE, 'stripe')
		const { impl } = stubFetch({
			'/api/integrations': () =>
				json([
					// The backend's own management surface. Excluded by `kind`, not by
					// name, so the backend's identity never appears in this repo.
					{ slug: 'management', kind: 'built-in', canRemove: false },
					{ slug: mine, kind: 'mcp', displayUrl: 'https://example.com/mcp', authMethods: [] },
					{ slug: theirs, kind: 'mcp', authMethods: [] },
				]),
		})

		const result = await makeClient(impl).listIntegrations('key', WORKSPACE)

		expect(result).toHaveLength(1)
		expect(result[0]?.name).toBe('linear')
		expect(result[0]?.url).toBe('https://example.com/mcp')
	})
})

describe('error mapping', () => {
	it('maps 401 to an auth error', async () => {
		const { impl } = stubFetch({ '/api/integrations': () => new Response('nope', { status: 401 }) })
		await expect(makeClient(impl).listIntegrations('bad', WORKSPACE)).rejects.toBeInstanceOf(
			ToolBrokerAuthError,
		)
	})

	it('maps other failures to an http error carrying the status', async () => {
		const { impl } = stubFetch({ '/api/integrations': () => new Response('boom', { status: 500 }) })
		await expect(makeClient(impl).listIntegrations('key', WORKSPACE)).rejects.toMatchObject({
			constructor: ToolBrokerHttpError,
			status: 500,
		})
	})

	it('maps a transport failure to unavailable, so callers can degrade', async () => {
		const impl = vi.fn(async () => {
			throw new TypeError('connect ECONNREFUSED')
		}) as unknown as typeof fetch
		await expect(makeClient(impl).listIntegrations('key', WORKSPACE)).rejects.toBeInstanceOf(
			ToolBrokerUnavailableError,
		)
	})
})

const expectedSlug = (): string => `tk-${workspacePrefix(WORKSPACE).replace(/_$/, '')}`

// ---------------------------------------------------------------------------
// LOAD-BEARING. The toolkit endpoint is default-deny, so the only way a
// workspace reaches another workspace's tools is a membership pattern we emit
// that is broader than intended. The backend accepts `*` without complaint, so
// nothing downstream will catch this — these assertions are the last line.
// ---------------------------------------------------------------------------
describe('assertScopedPattern — over-grant guard', () => {
	const PREFIX = workspacePrefix(WORKSPACE)

	it.each([
		['*', 'the whole instance'],
		['', 'empty'],
		['   ', 'blank'],
		['hubspot', 'single segment, no wildcard'],
		['hubspot.*', 'single literal segment without a workspace prefix'],
		['w11111111222233334444555555555555-hubspot.*', 'hyphen prefix, not our scheme'],
		['*.*', 'wildcard first segment'],
		['*.org.public', 'wildcard first segment with literal tail'],
	])('refuses %j (%s)', (pattern) => {
		expect(() => assertScopedPattern(pattern)).toThrow(ToolBrokerPatternError)
	})

	it('accepts a properly scoped pattern', () => {
		expect(assertScopedPattern(`${PREFIX}hubspot.*`)).toBe(`${PREFIX}hubspot.*`)
	})

	it('always produces a pattern with a literal, prefixed first segment', () => {
		const pattern = integrationPattern(workspaceScopedSlug(WORKSPACE, 'anything at all'))
		const [first, ...rest] = pattern.split('.')

		expect(rest.length).toBeGreaterThanOrEqual(1) // at least two segments
		expect(first).not.toBe('*')
		expect(first).not.toContain('*')
		expect(first?.startsWith(PREFIX)).toBe(true)
		expect(pattern).not.toBe('*')
	})

	it('cannot be coaxed into a bare wildcard by a hostile integration name', () => {
		// A user naming an integration `*` must not produce `*.*` or `*`.
		const pattern = integrationPattern(workspaceScopedSlug(WORKSPACE, '*'))
		expect(() => assertScopedPattern(pattern)).not.toThrow()
		expect(pattern.startsWith(PREFIX)).toBe(true)
	})
})

describe('connect', () => {
	it('sends an empty credential map for a no-auth connection', async () => {
		// Verified against a live instance: the backend requires exactly one
		// credential origin even for template "none", and rejects the request with
		// an empty 400 body when none is present.
		const { impl, calls } = stubFetch({
			'/api/connections': () =>
				json({
					owner: 'org',
					name: 'shared',
					integration: 'slug',
					address: 'tools.slug.org.shared',
				}),
		})

		await makeClient(impl).connect('key', {
			integrationSlug: 'slug',
			template: 'none',
			auth: { type: 'none' },
		})

		const body = calls.at(-1)?.body as Record<string, unknown>
		expect(body.template).toBe('none')
		expect(body.values).toEqual({})
		expect(body.value).toBeUndefined()
	})

	it('sends the secret as the sole credential origin for an api key', async () => {
		const { impl, calls } = stubFetch({
			'/api/connections': () =>
				json({ owner: 'user', name: 'personal', integration: 'slug', address: 'a' }),
		})

		await makeClient(impl).connect('key', {
			integrationSlug: 'slug',
			template: 'apikey-0',
			auth: { type: 'api_key', value: 'secret-value' },
			scope: 'personal',
		})

		const body = calls.at(-1)?.body as Record<string, unknown>
		expect(body.value).toBe('secret-value')
		expect(body.values).toBeUndefined()
		expect(body.owner).toBe('user')
	})
})

describe('slug is addressable in code mode', () => {
	it('produces a slug usable with dot notation', () => {
		// A tool address is evaluated as a JS expression, so the slug has to be a
		// valid identifier. Verified live: the hyphenated form failed with
		// tool_not_found and no suggestions, while the underscore form resolved.
		const slug = workspaceScopedSlug(WORKSPACE, 'Deep Wiki')
		expect(slug).toMatch(/^[A-Za-z_$][\w$]*$/)
		expect(slug).not.toContain('-')
	})

	it('keeps a hostile name identifier-safe', () => {
		const slug = workspaceScopedSlug(WORKSPACE, 'a.b-c/d e')
		expect(slug).toMatch(/^[A-Za-z_$][\w$]*$/)
	})
})

describe('addIntegrationByUrl', () => {
	it('keys an OpenAPI spec url as `url`, not `value`', async () => {
		// Verified live: the url variant of the spec union requires `url`. Sending
		// `value` (the blob variant's key) fails with a bare "Missing key" and an
		// empty 400 body.
		const { impl, calls } = stubFetch({ '/api/openapi/specs': () => json({}) })

		await makeClient(impl).addIntegrationByUrl('key', {
			workspaceId: WORKSPACE,
			url: 'https://example.com/openapi.json',
			kind: 'openapi',
			name: 'example',
		})

		const body = calls.at(-1)?.body as { spec: Record<string, unknown> }
		expect(body.spec).toEqual({ kind: 'url', url: 'https://example.com/openapi.json' })
	})

	it('sends an MCP server as an endpoint, under its human name', async () => {
		const { impl, calls } = stubFetch({
			'/api/mcp/servers': () => json({}),
			// Auth discovery runs after registering; a server with no OAuth
			// metadata just leaves it as no-auth.
			'/api/oauth/probe': () => new Response('no metadata', { status: 404 }),
		})

		await makeClient(impl).addIntegrationByUrl('key', {
			workspaceId: WORKSPACE,
			url: 'https://example.com/mcp',
			kind: 'mcp',
			name: 'Example',
		})

		const register = calls.find((c) => c.url.includes('/api/mcp/servers'))
		const body = register?.body as Record<string, unknown>
		expect(body.endpoint).toBe('https://example.com/mcp')
		expect(body.slug).toBe(workspaceScopedSlug(WORKSPACE, 'Example'))
		// The slug carries the workspace prefix and is unreadable; the display
		// name must be what the user typed.
		expect(body.name).toBe('Example')
	})

	it('declares oauth2 at registration rather than bolting it on afterwards', async () => {
		// This is what makes the backend probe the endpoint's protected-resource
		// metadata and build a template that knows the provider's discovery URL.
		// Registering bare and attaching an auth template afterwards yields a
		// template with no discovery config, and scopes are resolved from that
		// config at authorize time — so the flow goes out with no scope at all and
		// mints a credential that authenticates and can read nothing.
		const { impl, calls } = stubFetch({ '/api/mcp/servers': () => json({}) })

		await makeClient(impl).addIntegrationByUrl('key', {
			workspaceId: WORKSPACE,
			url: 'https://mcp.example.com/mcp',
			kind: 'mcp',
			name: 'Example',
		})

		const register = calls.find((c) => c.url.includes('/api/mcp/servers'))
		expect((register?.body as { auth: unknown }).auth).toEqual({ kind: 'oauth2' })
		// And no separate auth call: the declaration above replaces it.
		expect(calls.filter((c) => c.url.endsWith('/auth'))).toEqual([])
	})
})

describe('Origin header', () => {
	it('sends an Origin on every request', async () => {
		// Verified live: without it the auth plane answers 403
		// MISSING_OR_NULL_ORIGIN and provisioning cannot sign in. curl succeeds
		// without one, so this only reproduces from a real client.
		const { impl, calls } = stubFetch({ '/api/integrations': () => json([]) })

		await makeClient(impl).listIntegrations('key', WORKSPACE)

		expect(calls).toHaveLength(1)
	})

	it('uses the broker base url as the Origin', async () => {
		const seen: Array<string | null> = []
		const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('Origin'))
			return json([])
		}) as unknown as typeof fetch

		await makeClient(impl).listIntegrations('key', WORKSPACE)

		expect(seen).toEqual(['http://broker.local'])
	})
})

describe('display names', () => {
	it('prefers the stored name over the prefixed slug', async () => {
		const slug = workspaceScopedSlug(WORKSPACE, 'linear')
		const { impl } = stubFetch({
			'/api/integrations': () => json([{ slug, name: 'Linear', kind: 'mcp', authMethods: [] }]),
		})

		const [integration] = await makeClient(impl).listIntegrations('key', WORKSPACE)
		expect(integration?.name).toBe('Linear')
	})

	it('falls back to the de-prefixed slug when the backend echoes the slug', async () => {
		// Anything registered without a name comes back with the slug as its name,
		// and the slug carries a 32-hex workspace prefix nobody wants to read.
		const slug = workspaceScopedSlug(WORKSPACE, 'linear')
		const { impl } = stubFetch({
			'/api/integrations': () => json([{ slug, name: slug, kind: 'mcp', authMethods: [] }]),
		})

		const [integration] = await makeClient(impl).listIntegrations('key', WORKSPACE)
		expect(integration?.name).toBe('linear')
	})
})

describe('startOAuth template', () => {
	it("uses the integration's own template id, never a constant", async () => {
		// The backend generates this id per integration and accepts a wrong one
		// SILENTLY, answering with an authorize URL that carries no scope. Passing
		// a hardcoded "oauth2" against an integration whose template is
		// "custom_r4o22w" is what produced a connected-but-useless credential.
		const { impl, calls } = stubFetch({
			'/api/oauth/start': () =>
				json({
					status: 'redirect',
					authorizationUrl: 'https://p.example.com/a?scope=read',
					state: 's',
				}),
		})

		await makeClient(impl).startOAuth('key', {
			client: 'dcr-x',
			integrationSlug: 'w0123_example',
			redirectUri: 'https://app.example.com/cb',
			template: 'custom_r4o22w',
		})

		expect((calls.at(-1)?.body as { template: string }).template).toBe('custom_r4o22w')
	})
})

describe('auth kind mapping', () => {
	it('recognises the backend spelling of an api-key method', async () => {
		// The backend spells it `apikey`. Mapping only `api_key` classified every
		// key-authenticated integration as "other", and the UI then offered it as
		// no-auth — a connect that cannot work.
		const slug = workspaceScopedSlug(WORKSPACE, 'petstore')
		const { impl } = stubFetch({
			'/api/integrations': () =>
				json([
					{
						slug,
						name: 'Petstore',
						kind: 'openapi',
						authMethods: [
							{ id: 'apikey-0', template: 'apikey-0', label: 'API key', kind: 'apikey' },
						],
					},
				]),
		})

		const [integration] = await makeClient(impl).listIntegrations('key', WORKSPACE)
		expect(integration?.authMethods[0]?.kind).toBe('api_key')
		// And the generated template id survives, since connect needs it.
		expect(integration?.authMethods[0]?.template).toBe('apikey-0')
	})
})

describe('connect template', () => {
	it("uses the integration's own template rather than the auth kind", async () => {
		// Same trap as the OAuth template: an api-key template is `apikey-0`, and
		// passing the literal `api_key` is accepted silently.
		const { impl, calls } = stubFetch({
			'/api/connections': () =>
				json({ owner: 'org', name: 'shared', integration: 'w0123_petstore', address: 'a' }),
		})

		await makeClient(impl).connect('key', {
			integrationSlug: 'w0123_petstore',
			template: 'apikey-0',
			auth: { type: 'api_key', value: 'secret' },
		})

		const body = calls.at(-1)?.body as Record<string, unknown>
		expect(body.template).toBe('apikey-0')
		expect(body.value).toBe('secret')
	})
})
