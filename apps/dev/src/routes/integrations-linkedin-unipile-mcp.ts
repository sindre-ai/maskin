import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { selfHealLinkedInMcpCredential } from '../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal'
import { createLinkedInMcpServer } from '../lib/integrations/providers/linkedin-unipile/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the LinkedIn (LinkedIn-backed) provider.
 * P3-K reshapes this from one shared `/mcp` returning every identity's tools
 * into ONE server PER IDENTITY, keyed by the fan-out instance slug on the URL
 * path. Sibling of `integrations-slack-mcp.ts`.
 *
 * Two endpoints:
 *   POST /api/integrations/linkedin-unipile/mcp/:instanceSlug
 *     — the productive shape. Scoped to a single connected LinkedIn identity
 *       (personal profile or one admined company page) identified by the fan-
 *       out instance slug (e.g. `linkedin-magnus-noeddegaard-personal`).
 *       Every Quick Add button in the agent MCP panel points here. The MCP
 *       server built for the request only exposes THIS identity's tools, so
 *       an agent that has identity-A's mcpServers entry attached physically
 *       cannot call identity-B's verbs.
 *
 *   POST /api/integrations/linkedin-unipile/mcp
 *     — legacy shape (pre-P3-K). Deprecated. Now answers `tools/list` with an
 *       explicit empty list and `tools/call` with a deprecation error that
 *       names the per-identity replacement. Kept as an endpoint rather than
 *       a 404 so any hand-added mcpServers entry still connects cleanly —
 *       the empty tool set and the pointer error are the visible signals to
 *       switch to the per-identity path. Before this de-trap the SDK's
 *       zero-tool path (server/mcp.js `setToolRequestHandlers`, gated by
 *       `_createRegisteredTool`) never installed the tools/list handler, so
 *       any call landed on a bare `-32601 Method not found` with nothing to
 *       explain the migration.
 *
 * Instance-slug matching is done against the in-process registry, which is
 * populated at connect-time (see linkedin-unipile.ts callback) and boot-time
 * (`repopulateLinkedInMcpRegistryOnBoot`). The URL scheme survives restarts:
 * `integrations.unipile_acc_slug` is persisted on the DB row, boot repopulation
 * rebuilds the same instance slugs Unipile enumerates, and self-heal covers
 * a boot that raced the registry.
 */

/**
 * The wire code + message every deprecated-aggregate `tools/call` returns.
 * The code is grepable in Sentry / logs and the message names the concrete
 * replacement path so an agent (or a human reading the transcript) has a
 * one-step migration recipe rather than a bare "not found".
 */
const DEPRECATED_AGGREGATE_TOOL_CALL_MESSAGE =
	'LINKEDIN_MCP_DEPRECATED_AGGREGATE: The aggregate /api/integrations/linkedin-unipile/mcp endpoint is deprecated and exposes no tools. Point your mcpServers entry at /api/integrations/linkedin-unipile/mcp/{instanceSlug}; enumerate instance slugs via GET /api/integrations/linkedin-unipile/identities.'

const PROVIDER = 'linkedin-unipile'

/**
 * Wire codes for the per-identity route when it cannot serve the requested
 * identity's tools. Both answer `tools/list` with a JSON-RPC error and
 * `tools/call` with an `isError` result, so an agent sees a named failure
 * rather than a connected server with zero tools.
 */
const LINKEDIN_UNAVAILABLE = 'LINKEDIN_UNAVAILABLE'
const LINKEDIN_IDENTITY_NOT_FOUND = 'LINKEDIN_IDENTITY_NOT_FOUND'

type RouteError = { code: string; message: string; retryable: boolean; validSlugs: string[] }

type WorkspaceIdentities = {
	instances: LinkedInMcpInstanceConfig[]
	/** Active credentials whose registry slot is empty because enumeration failed. */
	unavailableCredentials: number
	activeCredentials: number
}

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

async function resolveWorkspaceIdentities(
	db: Database,
	workspaceId: string,
): Promise<WorkspaceIdentities> {
	// P3-C · Filter on `status = 'active'` so a revoked row's still-registered
	// fan-out tools disappear from `tools/list` on the very next request, even
	// if the DELETE hook's `deregisterLinkedInMcpInstancesForIntegration` call
	// has not run. `integrations.status` is the truth (tech principles doc
	// core principle 3); the registry is a performance cache.
	const credentialRows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			actorId: integrations.actorId,
			createdBy: integrations.createdBy,
			externalId: integrations.externalId,
			status: integrations.status,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, PROVIDER),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)

	// Self-heal any credential whose registry entry is empty. Boot
	// repopulation covers the common restart case; this covers a boot that
	// raced a still-starting Unipile plus any credential whose connect-time
	// enumeration failed and needs a passive retry.
	const outcomes = await Promise.all(credentialRows.map(selfHealLinkedInMcpCredential))

	return {
		instances: credentialRows.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id)),
		unavailableCredentials: outcomes.filter((outcome) => outcome === 'unavailable').length,
		activeCredentials: credentialRows.length,
	}
}

/**
 * Decide whether a request whose slug matched nothing is an error or the
 * (unchanged) empty list. A workspace with no active credential is a
 * disconnected or revoked identity (P3-C) and keeps the empty list. With an
 * active credential present, an empty answer is never silent: either its
 * enumeration failed (retryable) or the slug is wrong (valid slugs named).
 */
function routeErrorForUnmatchedSlug(
	requestedSlug: string,
	identities: WorkspaceIdentities,
): RouteError | null {
	const validSlugs = identities.instances.map((cfg) => instanceSlug(cfg))
	if (identities.unavailableCredentials > 0) {
		return {
			code: LINKEDIN_UNAVAILABLE,
			message: `LinkedIn identities could not be loaded for this workspace (${identities.unavailableCredentials} active credential(s) failed enumeration), so no tools are available for "${requestedSlug}" right now. Retry in about a minute.`,
			retryable: true,
			validSlugs,
		}
	}
	if (identities.activeCredentials > 0) {
		return {
			code: LINKEDIN_IDENTITY_NOT_FOUND,
			message: `No connected LinkedIn identity matches "${requestedSlug}". Valid instance slugs: ${validSlugs.length > 0 ? validSlugs.join(', ') : '(none)'}.`,
			retryable: false,
			validSlugs,
		}
	}
	return null
}

/**
 * Install tools/list + tools/call handlers that answer with the given error.
 * Needed for the same SDK reason as the deprecated aggregate route: a server
 * with zero registered tools never installs these handlers, so without this
 * the client would see a bare `-32601 Method not found`.
 */
function serveRouteError(mcpServer: McpServer, err: RouteError): void {
	const text = `${err.code}: ${err.message} (retryable: ${err.retryable})`
	mcpServer.server.registerCapabilities({ tools: { listChanged: false } })
	mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
		throw new McpError(ErrorCode.InternalError, text, {
			code: err.code,
			retryable: err.retryable,
			validSlugs: err.validSlugs,
		})
	})
	mcpServer.server.setRequestHandler(CallToolRequestSchema, async () => ({
		isError: true,
		content: [{ type: 'text', text }],
	}))
}

/**
 * Per-identity MCP endpoint. The mounted-under path (see app-factory.ts) makes
 * `/:instanceSlug` resolve to e.g.
 * `/api/integrations/linkedin-unipile/mcp/linkedin-magnus-noeddegaard-personal`.
 * The server built here exposes exactly the tools of the one instance whose
 * slug matches — cross-identity tool leakage is impossible by construction.
 */
app.post('/:instanceSlug', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')
	const requestedSlug = c.req.param('instanceSlug')

	if (!workspaceId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Missing X-Workspace-Id header',
				undefined,
				'The LinkedIn MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const identities = await resolveWorkspaceIdentities(db, workspaceId)
	// Match on the composed instance slug (`linkedin-{acc}-{identity}`) so the
	// URL is stable and human-readable. A slug that resolves to nothing while
	// the workspace still has an active credential is an explicit error (see
	// routeErrorForUnmatchedSlug). Only a workspace with no active credential
	// — the credential was disconnected or revoked — keeps the empty tool set,
	// the signal for the agent to notice the identity is gone.
	const scoped = identities.instances.filter((cfg) => instanceSlug(cfg) === requestedSlug)
	const routeError =
		scoped.length === 0 ? routeErrorForUnmatchedSlug(requestedSlug, identities) : null

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId }, scoped)
	if (routeError) serveRouteError(mcpServer, routeError)

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}

	logger.info('LinkedIn MCP request (per-identity)', {
		workspaceId,
		actorId,
		method: (body as { method?: string })?.method,
		instanceSlug: requestedSlug,
		matched: scoped.length,
		errorCode: routeError?.code,
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/:instanceSlug', (c) => c.text('Method Not Allowed', 405))
app.delete('/:instanceSlug', (c) => c.text('Method Not Allowed', 405))

/**
 * Legacy aggregate endpoint (pre-P3-K). Deprecated. Serves an empty tool set
 * on `tools/list` and a deprecation-pointer error on `tools/call` — the
 * per-identity Quick Add UI writes per-identity URLs (see the /:instanceSlug
 * route above), so nothing under the current UX ever hits this path. Kept as
 * a live endpoint (rather than removing the mount) so a hand-added mcpServers
 * entry that still points here does not fail the transport handshake — it
 * sees an empty tools list plus, on any accidental tools/call, a message
 * that names the per-identity URL and the identities endpoint.
 *
 * The tools/list + tools/call handlers are wired manually on the low-level
 * Server here rather than through `McpServer.registerTool`. The MCP SDK
 * (1.29.0, `server/mcp.js` `setToolRequestHandlers`, gated by
 * `_createRegisteredTool`) only installs the tools capability + these two
 * handlers the first time a tool is registered. A zero-instance server
 * therefore advertises `capabilities:{}` and every `tools/list` call returns
 * `-32601 Method not found` — an unexplained error, contradicting the doc
 * above. Wiring the handlers directly here closes that trap and matches
 * what the doc has always claimed.
 */
app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')

	if (!workspaceId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Missing X-Workspace-Id header',
				undefined,
				'The LinkedIn MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId }, [])

	// Force-install the tools capability + tools/list + tools/call handlers
	// so the deprecated aggregate route serves a documented response instead
	// of `-32601 Method not found`. See file-level comment for why the SDK
	// leaves these off for a zero-tool server.
	mcpServer.server.registerCapabilities({ tools: { listChanged: false } })
	mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
	mcpServer.server.setRequestHandler(CallToolRequestSchema, async () => ({
		isError: true,
		content: [{ type: 'text', text: DEPRECATED_AGGREGATE_TOOL_CALL_MESSAGE }],
	}))

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}

	logger.info('LinkedIn MCP request (aggregate, deprecated)', {
		workspaceId,
		actorId,
		method: (body as { method?: string })?.method,
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/', (c) => c.text('Method Not Allowed', 405))
app.delete('/', (c) => c.text('Method Not Allowed', 405))

export default app
