import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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
): Promise<LinkedInMcpInstanceConfig[]> {
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
	await Promise.all(credentialRows.map(selfHealLinkedInMcpCredential))

	return credentialRows.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id))
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

	const allInstances = await resolveWorkspaceIdentities(db, workspaceId)
	// Match on the composed instance slug (`linkedin-{acc}-{identity}`) so the
	// URL is stable and human-readable. A slug that no longer resolves — the
	// identity was un-admined, the credential was disconnected — returns an
	// empty tool set rather than a 404; the empty list is the correct signal
	// for the agent to notice the identity is gone, and matches the
	// `github-*` MCP surface's shape.
	const scoped = allInstances.filter((cfg) => instanceSlug(cfg) === requestedSlug)

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId }, scoped)

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
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

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
