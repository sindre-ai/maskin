import type { Database } from '@maskin/db'
import { toolBrokerActors, workspaceToolBrokers } from '@maskin/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { decrypt } from '../lib/crypto'
import { logger } from '../lib/logger'
import { isHiddenTool, sanitiseBody } from '../lib/tool-broker/mcp-scrub'
import { verifyToolBrokerSessionToken } from '../lib/tool-broker/session-token'

// ---------------------------------------------------------------------------
// MCP proxy for the tool broker.
//
// Agent containers point one MCP server entry here instead of at the broker, so
// the broker's per-actor API key never enters a container — the container holds
// only a short-lived token scoped to its own workspace and actor.
//
// THE PROTOCOL DETAILS BELOW WERE MEASURED, NOT ASSUMED:
//
//   * The upstream is a STATEFUL Streamable HTTP session. `initialize` returns
//     an `mcp-session-id` header, and any later call without it is refused with
//     `-32000 Server not initialized`. So the header is forwarded in both
//     directions; a proxy that drops it turns every session into that error.
//
//   * `Accept` must list BOTH `application/json` and `text/event-stream`, or the
//     upstream answers `-32000 Not Acceptable`. We set it rather than trusting
//     the client to.
//
//   * Response framing is HOST-DEPENDENT: the same call returns plain JSON on
//     one build and SSE frames on another. `sanitiseBody` branches on the
//     response content type instead of assuming either.
//
//   * The four artifact tools cannot be removed by a toolkit block policy —
//     policies govern tool addresses inside code mode, not the fixed MCP tool
//     surface. They are filtered here, and calls to them are refused here.
// ---------------------------------------------------------------------------

// Unauthenticated at the middleware layer on purpose: the caller is a container,
// not a Maskin actor, so it carries a scoped session token this route verifies
// itself rather than an `ank_` API key.
type Env = {
	Variables: {
		db: Database
	}
}

const app = new Hono<Env>()

const jsonRpcError = (id: unknown, code: number, message: string) =>
	Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

app.post('/', async (c) => {
	const auth = c.req.header('Authorization')
	const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
	const claims = token ? verifyToolBrokerSessionToken(token) : null
	if (!claims) {
		return c.json({ error: { message: 'Invalid or expired tool broker session token' } }, 401)
	}

	// The workspace's own instance when it has one, else the default. Today every
	// row is NULL and this is the default for all of them; the indirection exists
	// so an instance per workspace is an orchestration change, not a migration.
	const defaultBaseUrl = process.env.TOOL_BROKER_URL
	if (!defaultBaseUrl) {
		// Config, not flag, is the kill switch: with no URL this path does not
		// exist at all.
		return c.json({ error: { message: 'Tool broker is not configured' } }, 404)
	}

	const body = await c.req.json().catch(() => null)
	if (!body || typeof body !== 'object') {
		return jsonRpcError(null, -32700, 'Parse error')
	}
	const message = body as { id?: unknown; method?: unknown; params?: unknown }

	// Refuse artifact tool calls before they leave our process. Filtering them
	// from tools/list is not sufficient on its own — a client that already knows
	// the name could still call it.
	if (message.method === 'tools/call') {
		const params = message.params as { name?: unknown } | undefined
		if (isHiddenTool(params?.name)) {
			return jsonRpcError(message.id, -32601, `Unknown tool: ${String(params?.name)}`)
		}
	}

	const db = c.get('db')

	const [provisioned] = await db
		.select()
		.from(workspaceToolBrokers)
		.where(
			and(
				eq(workspaceToolBrokers.workspaceId, claims.workspaceId),
				eq(workspaceToolBrokers.status, 'active'),
			),
		)
		.limit(1)
	if (!provisioned) {
		return jsonRpcError(message.id, -32000, 'This workspace has no tool broker toolkit')
	}

	const [actor] = await db
		.select()
		.from(toolBrokerActors)
		.where(eq(toolBrokerActors.actorId, claims.actorId))
		.limit(1)
	if (!actor) {
		return jsonRpcError(message.id, -32000, 'This actor has no tool broker identity')
	}

	let apiKey: string
	try {
		apiKey = decrypt(actor.apiKey)
	} catch (error) {
		logger.error('Failed to decrypt tool broker actor key', {
			actorId: claims.actorId,
			error: error instanceof Error ? error.message : String(error),
		})
		return jsonRpcError(message.id, -32000, 'Tool broker credential unavailable')
	}

	const upstreamHeaders: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		// Both types required upstream.
		Accept: 'application/json, text/event-stream',
	}
	// Forward the session id when the client has one, so the upstream session
	// continues rather than restarting.
	const sessionId = c.req.header('mcp-session-id')
	if (sessionId) upstreamHeaders['mcp-session-id'] = sessionId

	// The workspace's own instance when it has one, else the default.
	const baseUrl = provisioned.endpointUrl ?? defaultBaseUrl

	let upstream: Response
	try {
		upstream = await fetch(
			`${baseUrl.replace(/\/+$/, '')}/mcp/toolkits/${provisioned.toolkitSlug}`,
			{
				method: 'POST',
				headers: upstreamHeaders,
				body: JSON.stringify(body),
			},
		)
	} catch (error) {
		// An outage must degrade the session, not fail it: the agent loses broker
		// tools and carries on with everything else.
		logger.warn('Tool broker unreachable from MCP proxy', {
			workspaceId: claims.workspaceId,
			error: error instanceof Error ? error.message : String(error),
		})
		return jsonRpcError(message.id, -32000, 'Tool broker is unavailable')
	}

	const contentType = upstream.headers.get('content-type')
	const sanitised = sanitiseBody(await upstream.text(), contentType)

	const responseHeaders: Record<string, string> = {
		'Content-Type': contentType ?? 'application/json',
	}
	// Hand the session id back so the client can continue the session.
	const upstreamSession = upstream.headers.get('mcp-session-id')
	if (upstreamSession) responseHeaders['mcp-session-id'] = upstreamSession

	return new Response(sanitised, { status: upstream.status, headers: responseHeaders })
})

// The upstream is request/response only; server-initiated streams are not used.
app.get('/', (c) => c.json({ error: { message: 'Method not allowed' } }, 405))
app.delete('/', (c) => c.json({ error: { message: 'Method not allowed' } }, 405))

export default app
