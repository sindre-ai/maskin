import { OpenAPIHono } from '@hono/zod-openapi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The provisioning layer talks to a live backend, so it is stubbed here; its own
// behaviour is covered by the client unit tests and the integration test. What
// these tests own is the ROUTE contract: URL validation, degradation when the
// backend is down, and the not-configured path.
const ensureProvisioned = vi.fn()
const getToolBrokerClient = vi.fn()

vi.mock('../../lib/tool-broker/provisioning', () => ({
	ensureProvisioned: (...args: unknown[]) => ensureProvisioned(...args),
	getToolBrokerClient: () => getToolBrokerClient(),
}))

// Adding now asks the URL what it is first. Stubbed so these tests stay about
// the route contract rather than the network; the probe has its own unit tests.
const probeEndpoint = vi.fn()

vi.mock('../../lib/tool-broker/endpoint-probe', () => ({
	probeEndpoint: (...args: unknown[]) => probeEndpoint(...args),
}))

const { createTestApp } = await import('../setup')
const { ToolBrokerUnavailableError } = await import('@maskin/tool-broker')
const routes = (await import('../../routes/tool-broker')).default

const WORKSPACE = '11111111-2222-3333-4444-555555555555'

// Connect resolves the integration's own template id from this list, so the
// default stub has to carry authMethods — a wrong or missing template is the
// bug class these routes exist to avoid.
const INTEGRATION_WITH_METHODS = (slug: string) => ({
	slug,
	name: slug,
	kind: 'mcp' as const,
	removable: true,
	url: 'https://mcp.example.com/mcp',
	authMethods: [
		{ id: 'none', template: 'none', label: 'None', kind: 'none' as const },
		{ id: 'apikey-0', template: 'apikey-0', label: 'API key', kind: 'api_key' as const },
	],
})

const makeClient = (overrides: Record<string, unknown> = {}) => ({
	listIntegrations: vi
		.fn()
		.mockResolvedValue([
			INTEGRATION_WITH_METHODS('w_linear'),
			INTEGRATION_WITH_METHODS('w_stripe'),
			INTEGRATION_WITH_METHODS('w_x'),
		]),
	listConnections: vi.fn().mockResolvedValue([]),
	addIntegrationByUrl: vi.fn().mockResolvedValue({ slug: 'w-slug' }),
	connect: vi.fn().mockResolvedValue({ address: 'tools.x.org.shared', scope: 'workspace' }),
	admitIntegration: vi.fn().mockResolvedValue(undefined),
	disconnect: vi.fn().mockResolvedValue(undefined),
	...overrides,
})

const provisionedWith = (client: ReturnType<typeof makeClient>) => ({
	client,
	apiKey: 'key',
	toolkit: {
		rowId: '00000000-0000-4000-8000-000000000001',
		toolkitId: 'tk-1',
		toolkitSlug: 'tk-slug',
	},
})

const post = (path: string, body: unknown) =>
	new Request(`http://localhost/api/tool-broker${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': WORKSPACE },
		body: JSON.stringify(body),
	})

beforeEach(() => {
	getToolBrokerClient.mockReturnValue({})
	// Most tests are not about the probe; default it to a plain OAuth server.
	probeEndpoint.mockResolvedValue({ kind: 'mcp', auth: 'oauth2' })
})

afterEach(() => {
	vi.clearAllMocks()
})

describe('GET /api/tool-broker', () => {
	it('reports not configured without calling the backend', async () => {
		getToolBrokerClient.mockReturnValue(null)
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			new Request('http://localhost/api/tool-broker', { headers: { 'X-Workspace-Id': WORKSPACE } }),
		)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ configured: false, available: false, integrations: [] })
		expect(ensureProvisioned).not.toHaveBeenCalled()
	})

	it('marks an integration connected only when it has a connection', async () => {
		const client = makeClient({
			listIntegrations: vi.fn().mockResolvedValue([
				{
					slug: 'w_linear',
					name: 'linear',
					kind: 'mcp',
					removable: true,
					url: null,
					authMethods: [],
				},
				{
					slug: 'w_stripe',
					name: 'stripe',
					kind: 'mcp',
					removable: true,
					url: null,
					authMethods: [],
				},
			]),
			listConnections: vi
				.fn()
				.mockResolvedValue([
					{ integrationSlug: 'w_linear', address: 'a', name: 'shared', scope: 'workspace' },
				]),
		})
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			new Request('http://localhost/api/tool-broker', { headers: { 'X-Workspace-Id': WORKSPACE } }),
		)
		const body = (await res.json()) as { integrations: Array<{ slug: string; connected: boolean }> }

		// Available to the workspace is not the same as usable — an integration
		// with no connection has no callable tools.
		expect(body.integrations.find((i) => i.slug === 'w_linear')?.connected).toBe(true)
		expect(body.integrations.find((i) => i.slug === 'w_stripe')?.connected).toBe(false)
	})

	it('degrades to unavailable rather than failing when the backend is down', async () => {
		ensureProvisioned.mockRejectedValue(new ToolBrokerUnavailableError(new Error('ECONNREFUSED')))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			new Request('http://localhost/api/tool-broker', { headers: { 'X-Workspace-Id': WORKSPACE } }),
		)

		// A broker outage must not take out the settings page.
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ configured: true, available: false })
	})
})

describe('POST /api/tool-broker/integrations', () => {
	it.each([
		['not-a-url', 'unparseable'],
		['http://example.com/mcp', 'plaintext non-loopback'],
		['https://user:pw@example.com/mcp', 'credentials embedded in the URL'],
		['ftp://example.com/spec.json', 'non-http scheme'],
	])('rejects %j (%s)', async (url) => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(post('/integrations', { url, kind: 'mcp' }))

		expect(res.status).toBe(400)
		// Nothing reached the backend — validation happens at the boundary.
		expect(client.addIntegrationByUrl).not.toHaveBeenCalled()
	})

	it('accepts an https URL and returns the namespaced slug', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://mcp.example.com/mcp', kind: 'mcp', name: 'Example' }),
		)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ slug: 'w-slug' })
	})

	it('allows http for localhost so local development works', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'http://localhost:9000/mcp', kind: 'mcp' }),
		)

		expect(res.status).toBe(200)
	})

	it('returns 503 when the backend is unreachable', async () => {
		ensureProvisioned.mockRejectedValue(new ToolBrokerUnavailableError(new Error('down')))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://mcp.example.com/mcp', kind: 'mcp' }),
		)

		expect(res.status).toBe(503)
	})
})

describe('POST /api/tool-broker/integrations/:slug/connect', () => {
	it('admits the integration into the toolkit after connecting', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations/w_linear/connect', { auth: { type: 'none' } }),
		)

		expect(res.status).toBe(200)
		// Connecting alone leaves the tools unreachable: the toolkit is
		// default-deny, so the admit step is what makes them callable.
		expect(client.admitIntegration).toHaveBeenCalledWith('key', {
			toolkitId: 'tk-1',
			integrationSlug: 'w_linear',
		})
	})

	it('passes an api key through as the credential', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		await app.request(
			post('/integrations/w_stripe/connect', { auth: { type: 'api_key', value: 'sk-test' } }),
		)

		expect(client.connect).toHaveBeenCalledWith(
			'key',
			expect.objectContaining({
				auth: { type: 'api_key', value: 'sk-test' },
				// Resolved from the integration, not the literal auth kind.
				template: 'apikey-0',
			}),
		)
	})

	it('rejects an unknown auth type', async () => {
		const { app } = createTestApp(routes, '/api/tool-broker')
		// 'oauth' is a supported type now, so this needs a genuinely unknown one.
		const res = await app.request(post('/integrations/w_x/connect', { auth: { type: 'saml' } }))
		expect(res.status).toBe(400)
	})
})

describe('catalogue icons', () => {
	// Icons are self-hosted so a browser never fetches one from the catalogue's
	// source — an upstream icon URL in the DOM leaks that hostname on every page
	// view, invisibly to any scan of our code.
	let storage: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }

	// Built by hand rather than via createTestApp: storageProvider has to be set
	// by middleware registered BEFORE the routes, or the handlers never see it.
	const appWithStorage = () => {
		storage = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn() }
		const app = new OpenAPIHono()
		app.use('*', async (c, next) => {
			c.set('db', {} as never)
			c.set('actorId', 'test-actor-id')
			c.set('storageProvider', storage as never)
			await next()
		})
		app.route('/api/tool-broker', routes as never)
		return app
	}

	const putIcon = (domain: string, body: string, contentType = 'image/png') =>
		new Request(`http://localhost/api/tool-broker/catalog/icons/${domain}`, {
			method: 'PUT',
			headers: { 'Content-Type': contentType },
			body,
		})

	it('stores an icon under a domain-keyed path and returns the key, not a URL', async () => {
		const app = appWithStorage()
		const res = await app.request(putIcon('linear.app', 'fake-png-bytes'))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { path: string }
		expect(body.path).toBe('tool-broker/icons/linear.app')
		// A URL here would be refused by the catalogue column, so returning one
		// would make the sync job's job impossible.
		expect(body.path).not.toMatch(/^[a-z]+:/i)
		expect(storage.put).toHaveBeenCalled()
	})

	it.each([
		['..%2F..%2Fetc%2Fpasswd', 'encoded path traversal'],
		['not%20a%20domain', 'spaces'],
		['localhost', 'no dot, so not a domain'],
	])('refuses %j (%s) rather than letting it steer a storage key', async (domain) => {
		const app = appWithStorage()
		const res = await app.request(putIcon(domain, 'bytes'))

		// 400 from the domain check, or 404 when the shape does not even route —
		// both are refusals, and neither writes anything.
		expect([400, 404]).toContain(res.status)
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('refuses a non-image content type', async () => {
		// Otherwise this is a general-purpose file drop that serves back whatever
		// was uploaded, under our own origin.
		const app = appWithStorage()
		const res = await app.request(putIcon('linear.app', '<script>alert(1)</script>', 'text/html'))

		expect(res.status).toBe(400)
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('refuses an empty body', async () => {
		const app = appWithStorage()
		const res = await app.request(putIcon('linear.app', ''))
		expect(res.status).toBe(400)
	})

	it('serves a stored icon from our own origin', async () => {
		const app = appWithStorage()
		storage.get.mockImplementation(async (key: string) =>
			key.endsWith('.type') ? Buffer.from('image/svg+xml') : Buffer.from('bytes'),
		)

		const res = await app.request(
			new Request('http://localhost/api/tool-broker/catalog/icons/linear.app'),
		)

		expect(res.status).toBe(200)
		expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
	})

	it('404s for an icon that was never stored', async () => {
		const app = appWithStorage()
		storage.get.mockRejectedValue(new Error('not found'))

		const res = await app.request(
			new Request('http://localhost/api/tool-broker/catalog/icons/unknown.example'),
		)
		expect(res.status).toBe(404)
	})
})

describe('browsing the catalogue', () => {
	// The list is capped server-side, so `total` has to come from its own count
	// query. Returning the page length instead tells a user looking at 50 rows
	// that 50 is all there is — a wrong answer that looks like a right one.
	it('reports how many entries match, not how many this page returned', async () => {
		const { app, mockResults } = createTestApp(routes, '/api/tool-broker')
		mockResults.selectQueue = [
			[
				{
					id: 'a',
					name: 'DeepWiki',
					description: null,
					domain: 'deepwiki.com',
					iconPath: null,
					connectKind: 'mcp',
					endpointUrl: 'https://mcp.deepwiki.com/mcp',
					authKind: 'none',
					supportsDcr: false,
					status: 'active',
				},
			],
			[{ count: 578 }],
		]

		const res = await app.request(
			new Request('http://localhost/api/tool-broker/catalog', {
				headers: { 'X-Workspace-Id': 'ws-1' },
			}),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { entries: unknown[]; total: number }
		expect(body.entries).toHaveLength(1)
		expect(body.total).toBe(578)
	})
})

describe('POST /api/tool-broker/integrations — asking the URL what it is', () => {
	// Add used to accept anything. A documentation page registered happily and the
	// failure surfaced two steps later at Connect, as a 400 about OAuth — for a URL
	// that was never a server. This is the real case: a user pasted
	// https://developer.unipile.com/docs/mcp, which answers 404 HTML.

	it('refuses a URL that is not an MCP server, and says what it probably is', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'not-mcp', status: 404 })
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://developer.unipile.com/docs/mcp', kind: 'mcp' }),
		)

		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'documentation page',
		)
		expect(client.addIntegrationByUrl).not.toHaveBeenCalled()
	})

	it('refuses a host it cannot reach', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'unreachable' })
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://nope.example/mcp', kind: 'mcp' }),
		)

		expect(res.status).toBe(400)
		expect(client.addIntegrationByUrl).not.toHaveBeenCalled()
	})

	it('asks for a key rather than registering a server that would fail every call', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'mcp', auth: 'api_key' })
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://developer.unipile.com/mcp', kind: 'mcp' }),
		)

		expect(res.status).toBe(400)
		// The code is what lets the UI open the key fields instead of just showing
		// the message.
		expect((await res.json()) as { error: { code?: string } }).toMatchObject({
			error: { code: 'api_key_required' },
		})
		expect(client.addIntegrationByUrl).not.toHaveBeenCalled()
	})

	it('registers an api-key server with its header once the key is supplied', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'mcp', auth: 'api_key' })
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', {
				url: 'https://developer.unipile.com/mcp',
				kind: 'mcp',
				apiKeyHeader: { name: 'X-API-KEY', value: 'secret' },
			}),
		)

		expect(res.status).toBe(200)
		expect(client.addIntegrationByUrl).toHaveBeenCalledWith(
			'key',
			expect.objectContaining({ auth: 'api_key', headers: { 'X-API-KEY': 'secret' } }),
		)
	})

	it('passes the probed auth kind through instead of assuming OAuth', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'mcp', auth: 'none' })
		const { app } = createTestApp(routes, '/api/tool-broker')

		await app.request(post('/integrations', { url: 'https://mcp.deepwiki.com/mcp', kind: 'mcp' }))

		expect(client.addIntegrationByUrl).toHaveBeenCalledWith(
			'key',
			expect.objectContaining({ auth: 'none' }),
		)
	})

	it('rejects a header name that is not a header name', async () => {
		// It is sent onward as a header name; a newline in it is header injection.
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		probeEndpoint.mockResolvedValue({ kind: 'mcp', auth: 'api_key' })
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', {
				url: 'https://mcp.example.com/mcp',
				kind: 'mcp',
				apiKeyHeader: { name: 'X-Bad\r\nInjected: yes', value: 'v' },
			}),
		)

		expect(res.status).toBe(400)
		expect(client.addIntegrationByUrl).not.toHaveBeenCalled()
	})

	it('does not probe an OpenAPI spec, which is a document and answers no initialize', async () => {
		const client = makeClient()
		ensureProvisioned.mockResolvedValue(provisionedWith(client))
		const { app } = createTestApp(routes, '/api/tool-broker')

		const res = await app.request(
			post('/integrations', { url: 'https://example.com/openapi.json', kind: 'openapi' }),
		)

		expect(res.status).toBe(200)
		expect(probeEndpoint).not.toHaveBeenCalled()
	})
})
