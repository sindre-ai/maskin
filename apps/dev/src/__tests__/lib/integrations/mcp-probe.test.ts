import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listTools = vi.fn()
const connect = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const transportArgs: unknown[] = []

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: class {
		connect = connect
		listTools = listTools
		close = close
	},
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
	StreamableHTTPClientTransport: class {
		constructor(...args: unknown[]) {
			transportArgs.push(...args)
		}
	},
}))
vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async (host: string) =>
		host === 'internal.example.com'
			? [{ address: '10.0.0.5', family: 4 }]
			: [{ address: '93.184.216.34', family: 4 }],
	),
}))

const { ProbeRefusedError, fetchWithCheckedRedirects, probeMcpTools } = await import(
	'../../../lib/integrations/mcp-probe'
)

describe('probeMcpTools', () => {
	beforeEach(() => {
		connect.mockReset().mockResolvedValue(undefined)
		listTools.mockReset()
		transportArgs.length = 0
	})

	it('lists tools with a read or write default taken from the name', async () => {
		listTools.mockResolvedValue({
			tools: [
				{ name: 'get_transcript', description: 'One transcript' },
				{ name: 'list_meetings' },
				{ name: 'bookmark_meeting' },
			],
		})
		const result = await probeMcpTools('https://api.example.com/mcp', 'sk-1')
		expect(result).toEqual({
			ok: true,
			tools: [
				{ name: 'get_transcript', kind: 'read', description: 'One transcript' },
				{ name: 'list_meetings', kind: 'read' },
				{ name: 'bookmark_meeting', kind: 'write' },
			],
		})
		expect(transportArgs[1]).toEqual({
			requestInit: { headers: { Authorization: 'Bearer sk-1' } },
			fetch: expect.any(Function),
		})
		expect(close).toHaveBeenCalled()
	})

	it('says the key was rejected on a 401', async () => {
		connect.mockRejectedValue(Object.assign(new Error('HTTP 401: Unauthorized'), { code: 401 }))
		const result = await probeMcpTools('https://api.example.com/mcp', 'bad')
		expect(result).toMatchObject({ ok: false, reason: 'rejected' })
	})

	it('reports a slow server as unreachable', async () => {
		connect.mockRejectedValue(new Error('Request timed out'))
		const result = await probeMcpTools('https://api.example.com/mcp')
		expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
	})

	it.each([
		'http://api.example.com/mcp',
		'https://localhost/mcp',
		'https://127.0.0.1/mcp',
		'https://169.254.169.254/latest',
		'https://[::1]/mcp',
		'https://[::ffff:127.0.0.1]/mcp',
		'https://[::ffff:169.254.169.254]/latest',
		'https://[::ffff:10.0.0.1]/mcp',
		'https://internal.example.com/mcp',
	])('refuses %s without connecting', async (url) => {
		const result = await probeMcpTools(url, 'sk-1')
		expect(result).toMatchObject({ ok: false, reason: 'blocked' })
		expect(connect).not.toHaveBeenCalled()
	})

	it('still allows a public IPv4-mapped IPv6 host', async () => {
		listTools.mockResolvedValue({ tools: [] })
		const result = await probeMcpTools('https://[::ffff:93.184.216.34]/mcp')
		expect(result).toEqual({ ok: true, tools: [] })
	})
})

type Hop = { status: number; location?: string }

/** A fake fetch that answers each URL from the chain; anything else is a plain 200. */
function chainFetch(chain: Record<string, Hop>) {
	// Snapshots, not the init object: the wrapper reuses one Headers across hops.
	const calls: Array<{
		url: string
		method?: string
		body?: unknown
		redirect?: string
		authorization: string | null
	}> = []
	const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method,
			body: init?.body,
			redirect: init?.redirect,
			authorization: new Headers(init?.headers).get('authorization'),
		})
		const hop = chain[String(input)]
		if (!hop) return new Response('ok', { status: 200 })
		return new Response(null, {
			status: hop.status,
			headers: hop.location ? { location: hop.location } : {},
		})
	})
	return { fake: fake as unknown as typeof fetch, calls }
}

const START = 'https://api.example.com/mcp'

describe('fetchWithCheckedRedirects', () => {
	it.each([
		['loopback', 'https://127.0.0.1/admin'],
		['10.x', 'https://10.0.0.5/x'],
		['a name that resolves to 10.x', 'https://internal.example.com/x'],
		['link-local', 'https://169.254.169.254/latest'],
		['IPv4 inside IPv6', 'https://[::ffff:7f00:1]/x'],
		['plain http', 'http://api.example.com/x'],
	])('refuses a redirect to %s without fetching it', async (_label, location) => {
		const { fake, calls } = chainFetch({ [START]: { status: 302, location } })
		await expect(fetchWithCheckedRedirects(fake)(START, { method: 'POST' })).rejects.toBeInstanceOf(
			ProbeRefusedError,
		)
		expect(calls.map((c) => c.url)).toEqual([START])
	})

	it('checks every hop, not only the first', async () => {
		const { fake, calls } = chainFetch({
			[START]: { status: 307, location: 'https://cdn.example.com/a' },
			'https://cdn.example.com/a': { status: 307, location: 'https://127.0.0.1/b' },
		})
		await expect(fetchWithCheckedRedirects(fake)(START)).rejects.toBeInstanceOf(ProbeRefusedError)
		expect(calls.map((c) => c.url)).toEqual([START, 'https://cdn.example.com/a'])
	})

	it('follows up to three redirects to public https addresses', async () => {
		const { fake, calls } = chainFetch({
			[START]: { status: 302, location: 'https://a.example.com/1' },
			'https://a.example.com/1': { status: 307, location: '/2' },
			'https://a.example.com/2': { status: 308, location: 'https://b.example.com/3' },
		})
		const response = await fetchWithCheckedRedirects(fake)(START)
		expect(response.status).toBe(200)
		expect(calls.map((c) => c.url)).toEqual([
			START,
			'https://a.example.com/1',
			'https://a.example.com/2',
			'https://b.example.com/3',
		])
		expect(calls.every((c) => c.redirect === 'manual')).toBe(true)
	})

	it('refuses a fourth redirect', async () => {
		const { fake, calls } = chainFetch({
			[START]: { status: 307, location: 'https://a.example.com/1' },
			'https://a.example.com/1': { status: 307, location: 'https://b.example.com/2' },
			'https://b.example.com/2': { status: 307, location: 'https://c.example.com/3' },
			'https://c.example.com/3': { status: 307, location: 'https://d.example.com/4' },
		})
		await expect(fetchWithCheckedRedirects(fake)(START)).rejects.toThrow(/too many times/)
		expect(calls).toHaveLength(4)
	})

	it('refuses a redirect with no Location', async () => {
		const { fake } = chainFetch({ [START]: { status: 307 } })
		await expect(fetchWithCheckedRedirects(fake)(START)).rejects.toThrow(/no address/)
	})

	it('keeps Authorization on the same origin and drops it on another', async () => {
		const { fake, calls } = chainFetch({
			[START]: { status: 307, location: '/v2/mcp' },
			'https://api.example.com/v2/mcp': { status: 307, location: 'https://other.example.com/mcp' },
		})
		await fetchWithCheckedRedirects(fake)(START, { headers: { Authorization: 'Bearer sk-1' } })
		expect(calls.map((c) => c.authorization)).toEqual(['Bearer sk-1', 'Bearer sk-1', null])
	})

	it('continues a POST as a GET after a 303 and keeps the method after a 307', async () => {
		const { fake, calls } = chainFetch({
			[START]: { status: 307, location: 'https://a.example.com/1' },
			'https://a.example.com/1': { status: 303, location: 'https://b.example.com/2' },
		})
		await fetchWithCheckedRedirects(fake)(START, { method: 'POST', body: '{}' })
		expect(calls.map((c) => [c.method, c.body ?? null])).toEqual([
			['POST', '{}'],
			['POST', '{}'],
			['GET', null],
		])
	})
})

describe('probeMcpTools redirect handling', () => {
	beforeEach(() => {
		transportArgs.length = 0
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('reports a redirect to an internal address as a plain failure', async () => {
		const { fake } = chainFetch({ [START]: { status: 302, location: 'https://127.0.0.1/admin' } })
		vi.stubGlobal('fetch', fake)
		connect.mockReset().mockImplementation(async () => {
			const transport = transportArgs[1] as { fetch: typeof fetch }
			await transport.fetch(START, { method: 'POST' })
		})

		const result = await probeMcpTools(START, 'sk-1')

		expect(result).toEqual({
			ok: false,
			reason: 'blocked',
			message: 'That address is not reachable from here.',
		})
	})
})
