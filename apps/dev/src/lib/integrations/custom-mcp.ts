import { z } from '@hono/zod-openapi'
import { MASKED_VALUE, maskActorTools } from '../actor-tools-redaction'
import { decrypt } from '../crypto'

/** `integrations.provider` for a custom MCP server. See providers/custom-mcp/config.ts. */
export const CUSTOM_MCP_PROVIDER = 'custom-mcp'

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

const envSchema = z
	.record(
		z.string().regex(ENV_KEY_RE, 'Environment variable names are letters, digits and _'),
		z.string().max(4096),
	)
	.refine((v) => Object.keys(v).length <= 50, 'At most 50 environment variables')
const headersSchema = z
	.record(z.string().regex(HEADER_NAME_RE, 'Not a valid header name'), z.string().max(4096))
	.refine((v) => Object.keys(v).length <= 50, 'At most 50 headers')

/** A URL to call: http(s), or starting with a ${PLACEHOLDER} the container fills in. */
const urlSchema = z
	.string()
	.trim()
	.max(2048)
	.refine((v) => {
		if (v.startsWith('${')) return true
		try {
			const u = new URL(v)
			return u.protocol === 'http:' || u.protocol === 'https:'
		} catch {
			return false
		}
	}, 'Enter an http(s) URL')

export const customMcpServerSchema = z
	.object({
		type: z.enum(['stdio', 'http']).optional(),
		command: z.string().trim().min(1).max(512).optional(),
		args: z.array(z.string().max(2048)).max(100).optional(),
		env: envSchema.optional(),
		url: urlSchema.optional(),
		headers: headersSchema.optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		const http = v.type === 'http' || (v.type === undefined && v.url !== undefined)
		if (http && !v.url)
			ctx.addIssue({ code: 'custom', path: ['url'], message: 'A URL is required' })
		if (!http && !v.command) {
			ctx.addIssue({ code: 'custom', path: ['command'], message: 'A command is required' })
		}
	})

export type CustomMcpServer = z.infer<typeof customMcpServerSchema>

/** What lets a server be told apart on the page without opening its secrets. */
export function summarizeServer(server: CustomMcpServer): {
	transport: 'stdio' | 'http'
	target: string
	/** Served through the gateway, so it has Read / Read & write / No access. */
	gated: boolean
} {
	const gated = isGatewayable(server)
	const http = server.type === 'http' || (server.type === undefined && !!server.url)
	if (http) return { transport: 'http', target: server.url ?? '', gated }
	// Args can carry a credential; the summary is visible to every member.
	const masked = maskServer(server)
	return { transport: 'stdio', target: [masked.command, ...(masked.args ?? [])].join(' '), gated }
}

function asRecord(server: CustomMcpServer): Record<string, unknown> {
	return server as unknown as Record<string, unknown>
}

/** The server with env and header values (and secret-looking args) replaced by the mask. */
export function maskServer(server: CustomMcpServer): CustomMcpServer {
	const masked = maskActorTools({ mcpServers: { s: asRecord(server) } }) as {
		mcpServers: { s: CustomMcpServer }
	}
	const out = masked.mcpServers.s
	// A value that only names a saved credential is not a secret, so show it: it is what
	// lets a person see (and keep) which credential a server uses. Any other text stays masked.
	for (const field of ['env', 'headers'] as const) {
		const original = server[field]
		const shown = out[field]
		if (!original || !shown) continue
		for (const [key, value] of Object.entries(original)) {
			if (isCredentialReference(value)) shown[key] = value
		}
	}
	return out
}

const KEYCHAIN_REF = /\$\{KEYCHAIN_[A-Za-z0-9_]*\}/

/** True for a value that is a Keychain reference, with at most a short word like "Bearer" around it. */
export function isCredentialReference(value: string): boolean {
	if (!KEYCHAIN_REF.test(value)) return false
	return /^[A-Za-z ]{0,16}$/.test(value.replace(new RegExp(KEYCHAIN_REF, 'g'), ''))
}

export { MASKED_VALUE }

/** The registry key a custom server is attached under in a session's MCP config. */
export function customServerKey(row: { id: string; displayName: string | null }): string {
	const slug = (row.displayName ?? 'server')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
	return `custom-${slug || 'server'}-${row.id.slice(0, 8)}`
}

/** Decrypts a custom server row's definition, or null when the blob is unreadable or not a server. */
export function readCustomServer(row: { credentials: string | null }): CustomMcpServer | null {
	if (!row.credentials) return null
	try {
		const parsed = JSON.parse(decrypt(row.credentials)) as { server?: unknown }
		const result = customMcpServerSchema.safeParse(parsed.server)
		return result.success ? result.data : null
	} catch {
		return null
	}
}

// ── Gateway ────────────────────────────────────────────────────────────────
//
// An HTTP server at a public address is reached through Maskin, like Linear or Gmail: Maskin
// keeps its headers, the agent signs in with its own key, and Maskin refuses writes for a
// read-only agent. A stdio server runs inside the agent's container and cannot be watched
// from outside, and a URL that only resolves from inside the container (a ${PLACEHOLDER} or
// a private address) is not reachable from here, so those stay on or off.

const PRIVATE_V4 = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^192\.0\.0\./,
	/^(22[4-9]|2[3-5]\d)\./,
]

/** False for a loopback, private, link-local or otherwise internal address or name. */
export function isPublicHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '')
	if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return false
	if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return !PRIVATE_V4.some((re) => re.test(h))
	if (h.includes(':')) {
		if (h === '::' || h === '::1') return false
		if (/^(fc|fd|fe[89ab])/.test(h)) return false
		const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		return mapped ? isPublicHost(mapped[1] as string) : true
	}
	// A bare name ("redis", "api") only resolves on an internal network.
	return h.includes('.')
}

/** True when Maskin can sit in front of this server: HTTP, absolute URL, public host. */
export function isGatewayable(server: CustomMcpServer): boolean {
	const http = server.type === 'http' || (server.type === undefined && !!server.url)
	if (!http || !server.url || server.url.startsWith('$')) return false
	try {
		const u = new URL(server.url)
		return (u.protocol === 'https:' || u.protocol === 'http:') && isPublicHost(u.hostname)
	} catch {
		return false
	}
}

/** The entry an agent uses to reach a gated custom server through Maskin. */
export function customGatewayServerSpec(id: string): Record<string, unknown> {
	return {
		type: 'http',
		url: `\${MASKIN_API_URL}/api/custom-mcp-servers/${id}/gateway`,
		headers: {
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			// Lets the gateway honour a credential allowed for just this chat.
			'X-Maskin-Session-Id': '${SESSION_ID}',
		},
	}
}

/** Whether a stored row's server is served through the gateway (from its non-secret summary). */
export function isGatedRow(config: unknown): boolean {
	return (config as { custom_mcp?: { gated?: boolean } } | null)?.custom_mcp?.gated === true
}
