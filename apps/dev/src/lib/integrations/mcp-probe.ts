import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { classifyToolKind } from './tool-kind'

/** The modal gives a slow server this long before it shows the error band. */
export const MCP_PROBE_TIMEOUT_MS = 10_000

/** A server exposing more than this is cut off; the modal only ever keeps 20. */
const MAX_PROBED_TOOLS = 500

export type McpProbeTool = { name: string; kind: 'read' | 'write'; description?: string }

export type McpProbeResult =
	| { ok: true; tools: McpProbeTool[] }
	| { ok: false; reason: 'rejected' | 'unreachable' | 'invalid' | 'blocked'; message: string }

function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const a = address.toLowerCase()
		if (a === '::1' || a === '::' || a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd'))
			return true
		const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		return mapped?.[1] ? isPrivateAddress(mapped[1]) : false
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
	})
	const client = new Client({ name: 'maskin-extension-probe', version: '1.0.0' }, { capabilities: {} })
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
		return describeFailure(err)
	} finally {
		await client.close().catch(() => {})
	}
}
