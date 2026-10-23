import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { type AgentAccess, resolveAgentAccess } from '../lib/integrations/agent-access'
import {
	GATEWAY_BODY_LIMIT_BYTES,
	GATEWAY_PROVIDERS,
	annotateToolsList,
	buildUpstreamHeaders,
	decideToolCall,
	denialResult,
	parseJsonRpc,
	parseSseData,
	toSse,
	toolsCallName,
} from '../lib/integrations/mcp-gateway'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { getProvider } from '../lib/integrations/registry'
import { type ToolAnnotationsLike, isCommandGated } from '../lib/integrations/tool-kinds'
import { logger } from '../lib/logger'
import type { IntegrationConfig } from '../lib/types'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Gateway to a provider's hosted MCP server: `/api/integrations/:provider/gateway`.
 *
 * The agent talks to Maskin with its own API key. Maskin holds the provider token,
 * decides what the agent may call, and forwards the rest. The upstream URL comes only
 * from the provider's config, never from the request, so the route cannot be pointed at
 * another host.
 *
 * What it does to each message:
 *  - tools/call: classified read or write against the agent's access. A refused call is
 *    answered here as a failed tool result and never reaches the provider.
 *  - tools/list: forwarded, then every tool is marked read-only or not and one the agent
 *    cannot use says so in its description.
 *  - everything else (initialize, notifications, ping, resources, prompts, the SSE
 *    stream, session end): forwarded as is.
 */

type Env = { Variables: { db: Database; actorId: string } }

const app = new Hono<Env>()

const UPSTREAM_TIMEOUT_MS = 60_000
const FORWARDED_REQUEST_HEADERS = [
	'accept',
	'content-type',
	'mcp-session-id',
	'mcp-protocol-version',
	'last-event-id',
]
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control']

// What each server said about its own tools (readOnlyHint, destructiveHint), kept from the
// last tools/list so a later tools/call can be classified. Bounded; a miss falls back to the
// name rules, which fail closed.
const ANNOTATION_CACHE_MAX = 200
const annotationCache = new Map<string, Map<string, ToolAnnotationsLike>>()

function rememberAnnotations(key: string, annotations: Map<string, ToolAnnotationsLike>): void {
	if (annotations.size === 0) return
	if (annotationCache.size >= ANNOTATION_CACHE_MAX && !annotationCache.has(key)) {
		const oldest = annotationCache.keys().next().value
		if (oldest !== undefined) annotationCache.delete(oldest)
	}
	annotationCache.set(key, annotations)
}

/** Test seam. */
export function clearGatewayAnnotationCache(): void {
	annotationCache.clear()
}

function jsonRpcError(status: 400 | 403 | 404 | 413 | 502, code: number, message: string) {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

async function handle(c: import('hono').Context<Env>): Promise<Response> {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const provider = c.req.param('provider') ?? ''
	const workspaceId = c.req.header('x-workspace-id')

	if (!GATEWAY_PROVIDERS.has(provider)) {
		return c.json(createApiError('NOT_FOUND', 'No gateway for this provider'), 404)
	}
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}
	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const resolved = getProvider(provider)
	const server = resolved.config.mcp?.server as
		| { type?: string; url?: string; headers?: Record<string, string> }
		| undefined
	const envKey = resolved.config.mcp?.envKey
	if (!server?.url || server.type !== 'http' || !envKey || server.url.startsWith('$')) {
		return c.json(createApiError('NOT_FOUND', 'No hosted MCP server for this provider'), 404)
	}
	const label = resolved.config.displayName

	const [integration] = await db
		.select({ id: integrations.id, config: integrations.config })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, provider),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!integration) {
		return jsonRpcError(404, -32001, `${label} is not connected to this workspace.`)
	}
	if ((integration.config as IntegrationConfig | null)?.expose_to_agent_sessions === false) {
		return jsonRpcError(403, -32001, `${label} is switched off for agent sessions.`)
	}

	const access = (await resolveAgentAccess(db, workspaceId, integration.id, actorId)) ?? 'none'

	return proxyMcp(c, {
		workspaceId,
		actorId,
		provider,
		label,
		integrationId: integration.id,
		access,
		cacheKey: `${workspaceId}:${provider}`,
		upstreamUrl: server.url,
		upstreamHeaders: async () => {
			let token: string
			try {
				token = await new TokenManager().getValidToken(db, integration.id, resolved)
			} catch (err) {
				logger.warn('Gateway could not load the provider token', {
					workspaceId,
					integrationId: integration.id,
					provider,
					error: err instanceof Error ? err.name : 'unknown',
				})
				throw new GatewayUpstreamError(
					`${label} needs to be reconnected. Ask a workspace admin to reconnect it under Settings → Integrations.`,
				)
			}
			return buildUpstreamHeaders(server.headers, envKey, token)
		},
	})
}

/** What the proxy needs to know about one upstream MCP server and the agent calling it. */
export interface ProxyContext {
	workspaceId: string
	actorId: string
	/** Classifies tools (a provider name, or custom-mcp) and names the denied-call event. */
	provider: string
	label: string
	integrationId: string
	access: AgentAccess
	/** Remembers each server's own tool annotations between a tools/list and a later call. */
	cacheKey: string
	upstreamUrl: string
	/** The headers that sign in upstream. Throws GatewayUpstreamError when it cannot. */
	upstreamHeaders: () => Promise<Record<string, string>>
}

export class GatewayUpstreamError extends Error {}

/**
 * Judges and forwards one MCP message to the upstream server: refuses a tool call the
 * agent's access does not allow, marks each tool read or write in tools/list, and passes
 * everything else through. Shared by the provider gateway and the custom-server gateway.
 */
export async function proxyMcp(
	c: import('hono').Context<Env>,
	ctx: ProxyContext,
): Promise<Response> {
	const db = c.get('db')
	const { workspaceId, actorId, provider, label, access, cacheKey } = ctx
	const integration = { id: ctx.integrationId }
	const server = { url: ctx.upstreamUrl }

	// Read the body once: it is both judged and forwarded.
	const method = c.req.method
	let bodyText: string | undefined
	let message: ReturnType<typeof parseJsonRpc> | undefined
	if (method === 'POST') {
		bodyText = await c.req.text()
		if (Buffer.byteLength(bodyText) > GATEWAY_BODY_LIMIT_BYTES) {
			return jsonRpcError(413, -32600, 'Request too large.')
		}
		message = parseJsonRpc(bodyText)
		if (!message.ok) {
			return jsonRpcError(
				400,
				-32600,
				message.reason === 'batch'
					? 'JSON-RPC batches are not supported here. Send one message per request.'
					: 'Invalid JSON-RPC request.',
			)
		}
	}

	const rpc = message?.ok ? message.message : undefined
	const toolName = rpc ? toolsCallName(rpc) : null
	// A repeated key is read one way here (the last wins) and could be read the other way
	// upstream. PostHog exec is judged by its command, so what goes upstream is the
	// re-serialized message that was judged. Everything else is forwarded byte for byte.
	const forwardBody =
		rpc && toolName && isCommandGated(provider, toolName) ? JSON.stringify(rpc) : bodyText

	if (toolName) {
		const decision = decideToolCall({
			provider,
			providerLabel: label,
			toolName,
			args: rpc?.params?.arguments,
			access,
			annotations: annotationCache.get(cacheKey)?.get(toolName),
		})
		if (!decision.allowed) {
			try {
				await recordEvent(db, {
					workspaceId,
					actorId,
					action: 'agent_access_denied',
					entityType: 'integration',
					entityId: integration.id,
					data: {
						provider,
						tool: toolName,
						kind: decision.kind,
						access,
						// The inner tool only, never the json input: it can hold personal data.
						...(decision.innerTool ? { command_tool: decision.innerTool } : {}),
					},
				})
			} catch (err) {
				logger.warn('Could not record a denied gateway tool call', {
					workspaceId,
					integrationId: integration.id,
					error: err instanceof Error ? err.name : 'unknown',
				})
			}
			return new Response(
				JSON.stringify(denialResult(rpc?.id, decision.message ?? 'Access denied.')),
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
				},
			)
		}
	}

	let upstreamHeaders: Record<string, string>
	try {
		upstreamHeaders = await ctx.upstreamHeaders()
	} catch (err) {
		if (err instanceof GatewayUpstreamError) return jsonRpcError(502, -32002, err.message)
		throw err
	}

	const headers = new Headers()
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = c.req.header(name)
		if (value) headers.set(name, value)
	}
	// Never the caller's Authorization: that is the agent's Maskin key.
	for (const [name, value] of Object.entries(upstreamHeaders)) {
		headers.set(name, value)
	}

	let upstream: Response
	try {
		upstream = await fetch(server.url, {
			method,
			headers,
			body: forwardBody,
			redirect: 'manual',
			// A long-lived GET stream ends with the agent; a POST is bounded.
			signal: method === 'GET' ? c.req.raw.signal : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		})
	} catch (err) {
		logger.warn('Gateway upstream request failed', {
			workspaceId,
			provider,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return jsonRpcError(502, -32002, `${label} could not be reached. Try again shortly.`)
	}

	const responseHeaders = new Headers()
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name)
		if (value) responseHeaders.set(name, value)
	}

	if (rpc?.method !== 'tools/list' || !upstream.ok) {
		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
	}

	// tools/list: small and complete, so read it whole and rewrite.
	const contentType = upstream.headers.get('content-type') ?? ''
	const text = await upstream.text()
	const isSse = contentType.includes('text/event-stream')
	let payloads: unknown[]
	try {
		payloads = isSse ? parseSseData(text) : [JSON.parse(text)]
	} catch {
		return new Response(text, { status: upstream.status, headers: responseHeaders })
	}
	const rewritten = payloads.map((p) => {
		const m = p as { result?: { tools?: unknown[] } }
		if (!m?.result || !Array.isArray(m.result.tools)) return p
		const out = annotateToolsList(m.result as Parameters<typeof annotateToolsList>[0], {
			provider,
			providerLabel: label,
			access,
		})
		rememberAnnotations(cacheKey, out.upstreamAnnotations)
		return { ...m, result: out.result }
	})
	responseHeaders.delete('content-length')
	return new Response(isSse ? toSse(rewritten) : JSON.stringify(rewritten[0]), {
		status: upstream.status,
		headers: responseHeaders,
	})
}

app.post('/:provider/gateway', handle)
app.get('/:provider/gateway', handle)
app.delete('/:provider/gateway', handle)

export default app
