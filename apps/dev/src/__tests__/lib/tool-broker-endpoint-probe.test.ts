import { describe, expect, it, vi } from 'vitest'
import { probeEndpoint } from '../../lib/tool-broker/endpoint-probe'

// Fixtures shaped from real responses, captured while diagnosing the Unipile
// failure — see the comments on each.

const INITIALIZE_RESULT = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	result: {
		protocolVersion: '2024-11-05',
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: 'Unipile', version: '1.0' },
	},
})

/** How a streamable-http server actually replies: the result inside an SSE frame. */
const SSE_INITIALIZE_RESULT = `event: message\ndata: ${INITIALIZE_RESULT}\n\n`

const reply = (
	status: number,
	body = '',
	contentType = 'application/json',
	extraHeaders: Record<string, string> = {},
) => new Response(body, { status, headers: { 'Content-Type': contentType, ...extraHeaders } })

describe('probeEndpoint', () => {
	it('recognises a server that answers initialize with no credential', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(reply(200, INITIALIZE_RESULT))

		await expect(probeEndpoint('https://mcp.example.com/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'none',
		})
	})

	it('reads a result carried in an SSE frame', async () => {
		// The live Unipile endpoint replies this way; a JSON-only check would call
		// a working server "not an MCP server".
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(reply(200, SSE_INITIALIZE_RESULT, 'text/event-stream'))

		await expect(probeEndpoint('https://mcp.example.com/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'none',
		})
	})

	it('rejects a documentation page', async () => {
		// The actual bug: https://developer.unipile.com/docs/mcp answers 404 HTML,
		// and used to register happily.
		const fetchImpl = vi.fn().mockResolvedValue(reply(404, '<!doctype html>', 'text/html'))

		await expect(
			probeEndpoint('https://developer.unipile.com/docs/mcp', { fetchImpl }),
		).resolves.toEqual({ kind: 'not-mcp', status: 404 })
	})

	it('rejects a page that returns 200 HTML for every path', async () => {
		// An SPA shell answers 200 to anything. Status alone would let the
		// docs-page mistake straight back in.
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(reply(200, '<!doctype html><title>Docs</title>', 'text/html'))

		await expect(probeEndpoint('https://example.com/docs', { fetchImpl })).resolves.toEqual({
			kind: 'not-mcp',
			status: 200,
		})
	})

	it('calls a 401 with OAuth metadata an oauth2 server', async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.includes('.well-known/oauth-protected-resource')) {
				return reply(200, JSON.stringify({ authorization_servers: ['https://auth.example.com'] }))
			}
			return reply(401)
		})

		await expect(probeEndpoint('https://mcp.example.com/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'oauth2',
		})
	})

	it('calls a 401 with no OAuth metadata an api-key server', async () => {
		// Unipile: 401 on the endpoint, 404 on both well-known paths. Registering
		// this as OAuth is what produced the 400 the user saw.
		const fetchImpl = vi.fn(async (input: string | URL | Request) =>
			String(input).includes('.well-known') ? reply(404) : reply(401),
		)

		await expect(
			probeEndpoint('https://developer.unipile.com/mcp', { fetchImpl }),
		).resolves.toEqual({ kind: 'mcp', auth: 'api_key' })
	})

	it('treats a 403 the same as a 401', async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) =>
			String(input).includes('.well-known') ? reply(404) : reply(403),
		)

		await expect(
			probeEndpoint('https://mcp.example.com/mcp', { fetchImpl }),
		).resolves.toMatchObject({
			kind: 'mcp',
		})
	})

	it('reports an unreachable host rather than throwing', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

		await expect(probeEndpoint('https://nope.example/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'unreachable',
		})
	})

	it('does not let a failing metadata lookup break the probe', async () => {
		// A 401 endpoint plus well-known paths that time out still has to produce
		// an answer — api_key, since nothing evidenced OAuth.
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes('.well-known')) throw new Error('timeout')
			return reply(401)
		})

		await expect(probeEndpoint('https://mcp.example.com/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'api_key',
		})
	})
})

describe('probeEndpoint — finding OAuth metadata that is not at the origin root', () => {
	// Captured verbatim from https://mcp.facebook.com/ads. Meta publishes its
	// metadata under the resource's PATH, per RFC 9728, and advertises the exact
	// URL in the 401. Looking only at the origin root finds neither, which
	// classified a fully DCR-capable OAuth server as wanting an API key.
	const META_CHALLENGE =
		'Bearer resource_metadata="https://mcp.facebook.com/.well-known/oauth-protected-resource/ads", scope="ads_management ads_read catalog_management"'

	it('follows the metadata URL the 401 advertises', async () => {
		const fetched: string[] = []
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			fetched.push(url)
			if (url === 'https://mcp.facebook.com/ads') {
				return reply(401, '', 'application/json', { 'WWW-Authenticate': META_CHALLENGE })
			}
			if (url === 'https://mcp.facebook.com/.well-known/oauth-protected-resource/ads') {
				return reply(200, JSON.stringify({ resource: 'https://mcp.facebook.com/ads' }))
			}
			return reply(404)
		})

		await expect(probeEndpoint('https://mcp.facebook.com/ads', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'oauth2',
		})
		// The advertised URL is tried first — no guessing needed when the server says.
		expect(fetched[1]).toBe('https://mcp.facebook.com/.well-known/oauth-protected-resource/ads')
	})

	it('finds path-scoped metadata even with no WWW-Authenticate header', async () => {
		// Not every server advertises it, so the path-inserted form is still tried.
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url === 'https://mcp.example.com/ads') return reply(401)
			if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/ads') {
				return reply(200, '{}')
			}
			return reply(404)
		})

		await expect(probeEndpoint('https://mcp.example.com/ads', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'oauth2',
		})
	})

	it('still finds metadata at the origin root, where most servers put it', async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url === 'https://mcp.example.com/mcp') return reply(401)
			if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
				return reply(200, '{}')
			}
			return reply(404)
		})

		await expect(probeEndpoint('https://mcp.example.com/mcp', { fetchImpl })).resolves.toEqual({
			kind: 'mcp',
			auth: 'oauth2',
		})
	})

	it('still calls it an api-key server when no metadata exists anywhere', async () => {
		// The genuine api-key case must survive the extra lookups.
		const fetchImpl = vi.fn(async (input: string | URL | Request) =>
			String(input).includes('.well-known') ? reply(404) : reply(401),
		)

		await expect(probeEndpoint('https://api.databuddy.cc/v1/mcp/', { fetchImpl })).resolves.toEqual(
			{ kind: 'mcp', auth: 'api_key' },
		)
	})
})
