import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { probeMcpTools } = await import('../../../lib/integrations/mcp-probe')

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
		expect(transportArgs[1]).toEqual({ requestInit: { headers: { Authorization: 'Bearer sk-1' } } })
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
