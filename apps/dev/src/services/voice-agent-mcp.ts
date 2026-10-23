import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import type { VoiceExternalMcpServer } from '@maskin/mcp'
import { and, asc, eq } from 'drizzle-orm'
import { isAuthRevokedError } from '../lib/integrations/errors'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { isSlackBotToken } from '../lib/integrations/providers/slack/mcp-server'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { isMaskinMcpEntry } from '../lib/mcp-session-header'
import type { IntegrationConfig } from '../lib/types'
import { resolveActorSecretEnv } from './session-manager'

/**
 * The remote MCP servers a Live call can use: the ones the user added to the
 * agent (`actors.tools.mcpServers`), nothing else. This is the same source and
 * the same placeholder rules chat uses (session-manager.ts), resolved here
 * in-process instead of in a container:
 *
 * - `${MASKIN_API_KEY}`, `${MASKIN_WORKSPACE_ID}`, `${MASKIN_API_URL}` are the
 *   agent's own key, the call's workspace and this API.
 * - `${AGENT_SECRET_*}` come from the agent's `tools.envFrom`.
 * - An integration's token variable (`${GMAIL_TOKEN}`, ...) is filled in only
 *   when the agent's config names it, through the same TokenManager and the
 *   same gates (not exposed to agents, revoked, Slack user token).
 *
 * Skipped, never guessed at: the Maskin MCP entry (the call already has those
 * tools in-process), stdio servers (they need a process to spawn, which a
 * voice call has no container for), and any server with a placeholder that
 * cannot be resolved.
 */

const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)\}/g

function placeholdersIn(value: string): string[] {
	return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string)
}

function expand(value: string, env: Record<string, string>): string {
	return value.replace(PLACEHOLDER_RE, (_, name: string) => env[name] ?? '')
}

// The guard's false branch would narrow the entry to `never`; only the answer matters here.
const isMaskinEntry: (entry: unknown) => boolean = isMaskinMcpEntry

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrivateIPv4(octets: number[]): boolean {
	const [a, b] = octets as [number, number]
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	)
}

/**
 * A voice call fetches these URLs from the API process, not from a sandbox, so
 * a workspace-editable URL must not reach this host's own network. This API
 * itself is allowed (the in-process Slack and LinkedIn servers live there);
 * anything else must be https and not a loopback, private or link-local host.
 *
 * Only literal hosts are checked: a public name that resolves to a private
 * address is not caught here. Redirects are refused separately, in
 * `createVoiceToolkit`.
 */
export function isAllowedVoiceMcpUrl(rawUrl: string, apiBaseUrl: string): boolean {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return false
	}
	if (url.origin === new URL(apiBaseUrl).origin) return true
	if (url.protocol !== 'https:') return false
	const host = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '')
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
		return false
	if (host.endsWith('.local')) return false
	if (host.includes(':')) {
		// IPv6 literal. Refuse the unspecified and loopback addresses, anything that
		// embeds an IPv4 address (mapped `::ffff:`, NAT64 `64:ff9b::`), unique-local
		// (fc00::/7) and link-local (fe80::/10).
		return !(
			host === '::' ||
			host === '::1' ||
			host.startsWith('::ffff:') ||
			host.startsWith('64:ff9b:') ||
			host.startsWith('fc') ||
			host.startsWith('fd') ||
			/^fe[89ab]/.test(host)
		)
	}
	const octets = host.split('.').map(Number)
	if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		return !isPrivateIPv4(octets)
	}
	return true
}

export interface ResolveVoiceAgentMcpInput {
	db: Database
	agentTools: unknown
	agentApiKey: string
	workspaceId: string
	apiBaseUrl: string
}

export async function resolveVoiceAgentMcpServers(
	input: ResolveVoiceAgentMcpInput,
): Promise<Record<string, VoiceExternalMcpServer>> {
	const { db, workspaceId, apiBaseUrl } = input
	const tools = isPlainObject(input.agentTools) ? input.agentTools : null
	const configured = tools && isPlainObject(tools.mcpServers) ? tools.mcpServers : null
	if (!configured) return {}

	type Candidate = {
		name: string
		url: string
		headers: Record<string, string>
		transport: 'http' | 'sse'
	}
	const candidates: Candidate[] = []
	for (const [name, entry] of Object.entries(configured)) {
		if (!isPlainObject(entry) || isMaskinEntry(entry)) continue
		if (
			typeof entry.url !== 'string' ||
			(entry.type !== undefined && entry.type !== 'http' && entry.type !== 'sse')
		) {
			logger.info('Voice call skips an agent MCP server it cannot reach over HTTP', {
				server: name,
				type: typeof entry.type === 'string' ? entry.type : 'stdio',
			})
			continue
		}
		const headers: Record<string, string> = {}
		if (isPlainObject(entry.headers)) {
			for (const [k, v] of Object.entries(entry.headers)) {
				if (typeof v === 'string') headers[k] = v
			}
		}
		candidates.push({
			name,
			url: entry.url,
			headers,
			transport: entry.type === 'sse' ? 'sse' : 'http',
		})
	}
	if (candidates.length === 0) return {}

	const env: Record<string, string> = {
		MASKIN_API_KEY: input.agentApiKey,
		MASKIN_WORKSPACE_ID: workspaceId,
		MASKIN_API_URL: apiBaseUrl,
	}
	Object.assign(env, resolveActorSecretEnv(tools?.envFrom, process.env).env)

	const needed = new Set<string>()
	for (const c of candidates) {
		for (const v of [c.url, ...Object.values(c.headers)]) {
			for (const name of placeholdersIn(v)) if (!(name in env)) needed.add(name)
		}
	}

	// Integration tokens, and only the ones the agent's own config names.
	if (needed.size > 0) {
		const active = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.status, 'active')))
			.orderBy(asc(integrations.createdAt))
		const tokenManager = new TokenManager()
		for (const integration of active) {
			let resolved: ReturnType<typeof getProvider>
			try {
				resolved = getProvider(integration.provider)
			} catch {
				continue
			}
			if (!resolved) continue
			const envVarName =
				resolved.config.mcp?.envKey ??
				`${integration.provider.toUpperCase().replace(/-/g, '_')}_TOKEN`
			if (!needed.has(envVarName) || envVarName in env) continue
			if ((integration.config as IntegrationConfig | null)?.expose_to_agent_sessions === false) {
				continue
			}
			try {
				const token = await tokenManager.getValidToken(db, integration.id, resolved)
				if (integration.provider === 'slack' && !isSlackBotToken(token)) continue
				env[envVarName] = token
			} catch (err) {
				if (!isAuthRevokedError(err)) {
					logger.warn('Voice call could not load an integration token', {
						provider: integration.provider,
						integrationId: integration.id,
						error: String(err),
					})
				}
			}
		}
	}

	const out: Record<string, VoiceExternalMcpServer> = {}
	for (const c of candidates) {
		const missing = [c.url, ...Object.values(c.headers)]
			.flatMap(placeholdersIn)
			.filter((name) => !(name in env))
		if (missing.length > 0) {
			logger.info('Voice call skips an agent MCP server with unresolved placeholders', {
				server: c.name,
				missing: [...new Set(missing)],
			})
			continue
		}
		const url = expand(c.url, env)
		if (!isAllowedVoiceMcpUrl(url, apiBaseUrl)) {
			logger.warn('Voice call skips an agent MCP server at a disallowed address', {
				server: c.name,
			})
			continue
		}
		out[c.name] = {
			url,
			headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, expand(v, env)])),
			transport: c.transport,
		}
	}
	return out
}
