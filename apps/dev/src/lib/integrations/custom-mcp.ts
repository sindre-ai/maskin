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
} {
	const http = server.type === 'http' || (server.type === undefined && !!server.url)
	if (http) return { transport: 'http', target: server.url ?? '' }
	// Args can carry a credential; the summary is visible to every member.
	const masked = maskServer(server)
	return { transport: 'stdio', target: [masked.command, ...(masked.args ?? [])].join(' ') }
}

function asRecord(server: CustomMcpServer): Record<string, unknown> {
	return server as unknown as Record<string, unknown>
}

/** The server with env and header values (and secret-looking args) replaced by the mask. */
export function maskServer(server: CustomMcpServer): CustomMcpServer {
	const masked = maskActorTools({ mcpServers: { s: asRecord(server) } }) as {
		mcpServers: { s: CustomMcpServer }
	}
	return masked.mcpServers.s
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
