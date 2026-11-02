import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { classifyToolKind } from './tool-kind'

/** The modal gives a slow server this long before it shows the error band. */
export const MCP_PROBE_TIMEOUT_MS = 10_000

/** A redirect chain longer than this is refused. */
const MAX_PROBE_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** A server exposing more than this is cut off; the modal only ever keeps 20. */
const MAX_PROBED_TOOLS = 500

export type McpProbeTool = { name: string; kind: 'read' | 'write'; description?: string }

export type McpProbeResult =
	| { ok: true; tools: McpProbeTool[] }
	| { ok: false; reason: 'rejected' | 'unreachable' | 'invalid' | 'blocked'; message: string }

function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const a = address.toLowerCase()
		if (
			a === '::1' ||
			a === '::' ||
			a.startsWith('fe80') ||
			a.startsWith('fc') ||
			a.startsWith('fd')
		)
			return true
		// IPv4 inside IPv6 (::ffff:a.b.c.d or ::a.b.c.d). new URL() rewrites the
		// dotted tail to hex (::ffff:7f00:1), so accept both spellings.
		const embedded = a.match(
			/^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
		)
		if (!embedded) return false
		if (embedded[1]) return isPrivateAddress(embedded[1])
		const hi = Number.parseInt(embedded[2] ?? '0', 16)
		const lo = Number.parseInt(embedded[3] ?? '0', 16)
		return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
	}
	const [a = 0, b = 0] = address.split('.').map(Number)
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	)
}

/**
 * The probe makes this server call a URL a workspace owner typed in, so it
 * must not be a way to reach our own network. HTTPS only, and every address the
 * host resolves to has to be public. A resolver answering differently between
 * this check and the connection is not covered.
 */
async function blockedReason(url: URL): Promise<string | null> {
	if (url.protocol !== 'https:') return 'The server URL must start with https://.'
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
		return 'That address is not reachable from here.'
	}
	const addresses = isIP(host)
		? [host]
		: await lookup(host, { all: true }).then(
				(r) => r.map((x) => x.address),
				() => null,
			)
	if (!addresses || addresses.length === 0) return "Couldn't find that server."
	return addresses.some(isPrivateAddress) ? 'That address is not reachable from here.' : null
}

/** A redirect hop the probe will not follow. The message is shown to the owner as is. */
export class ProbeRefusedError extends Error {}

/**
 * fetch for the probe's transport. The default fetch follows redirects, so a
 * public https server could send the probe on to an internal address that the
 * check on the typed URL never sees. This one asks for redirect: 'manual' and
 * follows a 3xx itself, at most 3 times, running the same check on every
 * target before fetching it. A hop that is not https, has no Location, fails
 * the check, or comes after the third is refused. The Authorization header is
 * dropped when a hop changes origin.
 */
export function fetchWithCheckedRedirects(
	fetchImpl: typeof fetch = fetch,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		let target = new URL(input)
		let method = init?.method ?? 'GET'
		let body = init?.body
		const headers = new Headers(init?.headers)
		for (let followed = 0; ; followed++) {
			const response = await fetchImpl(target, {
				...init,
				method,
				body,
				headers,
				redirect: 'manual',
			})
			if (!REDIRECT_STATUSES.has(response.status)) return response
			await response.body?.cancel().catch(() => {})
			if (followed >= MAX_PROBE_REDIRECTS) {
				throw new ProbeRefusedError('The server redirected too many times.')
			}
			const location = response.headers.get('location')
			if (!location) throw new ProbeRefusedError('The server sent a redirect with no address.')
			let next: URL
			try {
				next = new URL(location, target)
			} catch {
				throw new ProbeRefusedError('The server sent a redirect to an invalid address.')
			}
			const blocked = await blockedReason(next)
			if (blocked) throw new ProbeRefusedError(blocked)
			if (next.origin !== target.origin) headers.delete('authorization')
			// As fetch does: 303, and 301/302 after a POST, continue as a GET with no body.
			if (
				response.status === 303 ||
				(response.status !== 307 && response.status !== 308 && method === 'POST')
			) {
				method = 'GET'
				body = undefined
				headers.delete('content-type')
			}
			target = next
		}
	}
}

function describeFailure(err: unknown): McpProbeResult & { ok: false } {
	const code = (err as { code?: number }).code
	const message = err instanceof Error ? err.message : String(err)
	if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
		return { ok: false, reason: 'rejected', message: 'The server rejected the API key.' }
	}
	if (/timed? ?out|abort/i.test(message)) {
		return {
			ok: false,
			reason: 'unreachable',
			message: `The server did not answer within ${MCP_PROBE_TIMEOUT_MS / 1000} seconds.`,
		}
	}
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|certificate/i.test(message)) {
		return { ok: false, reason: 'unreachable', message: "Couldn't reach the server." }
	}
	return {
		ok: false,
		reason: 'invalid',
		message: "The server didn't answer like an MCP server.",
	}
}

/**
 * Ask a hosted MCP server for its tools (tools/list) with the given API key as
 * a Bearer header. Nothing is stored; the key lives only for this call. Each
 * tool comes back with a read/write default from its name.
 */
export async function probeMcpTools(serverUrl: string, apiKey?: string): Promise<McpProbeResult> {
	let url: URL
	try {
		url = new URL(serverUrl)
	} catch {
		return { ok: false, reason: 'blocked', message: 'That is not a valid URL.' }
	}
	const blocked = await blockedReason(url)
	if (blocked) return { ok: false, reason: 'blocked', message: blocked }

	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
		fetch: fetchWithCheckedRedirects(),
	})
	const client = new Client(
		{ name: 'maskin-extension-probe', version: '1.0.0' },
		{ capabilities: {} },
	)
	try {
		await client.connect(transport, { timeout: MCP_PROBE_TIMEOUT_MS })
		const listed = await client.listTools(undefined, { timeout: MCP_PROBE_TIMEOUT_MS })
		const tools = (listed.tools ?? []).slice(0, MAX_PROBED_TOOLS).map((t) => ({
			name: t.name,
			kind: classifyToolKind(t.name),
			...(t.description ? { description: t.description.slice(0, 300) } : {}),
		}))
		return { ok: true, tools }
	} catch (err) {
		if (err instanceof ProbeRefusedError) {
			return { ok: false, reason: 'blocked', message: err.message }
		}
		return describeFailure(err)
	} finally {
		await client.close().catch(() => {})
	}
}
