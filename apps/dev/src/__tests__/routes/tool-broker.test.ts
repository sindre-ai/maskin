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

const { createTestApp } = await import('../setup')
const { ToolBrokerUnavailableError } = await import('@maskin/tool-broker')
const routes = (await import('../../routes/tool-broker')).default

const WORKSPACE = '11111111-2222-3333-4444-555555555555'

const makeClient = (overrides: Record<string, unknown> = {}) => ({
	listIntegrations: vi.fn().mockResolvedValue([]),
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
	toolkit: { toolkitId: 'tk-1', toolkitSlug: 'tk-slug' },
})

const post = (path: string, body: unknown) =>
	new Request(`http://localhost/api/tool-broker${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': WORKSPACE },
		body: JSON.stringify(body),
	})

beforeEach(() => {
	getToolBrokerClient.mockReturnValue({})
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
			}),
		)
	})

	it('rejects an unknown auth type', async () => {
		const { app } = createTestApp(routes, '/api/tool-broker')
		const res = await app.request(post('/integrations/w_x/connect', { auth: { type: 'oauth' } }))
		expect(res.status).toBe(400)
	})
})
