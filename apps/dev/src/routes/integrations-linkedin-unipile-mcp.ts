import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration } from '@maskin/mcp/linkedin'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createLinkedInMcpServer } from '../lib/integrations/providers/linkedin-unipile/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the LinkedIn (LinkedIn-backed) provider,
 * mounted at `/api/integrations/linkedin-unipile/mcp`. Sibling of
 * `integrations-slack-mcp.ts`.
 *
 * R11-A · fan-out. The old flat `linkedin_*` per-credential server is gone.
 * Every connected LinkedIn identity for the calling actor (their personal
 * profile plus every admined page) is served as its own MCP instance
 * registered under `linkedin-{unipileAccSlug}-{identitySlug}`. This handler:
 *
 *   1. Resolves the calling actor's linkedin-unipile credentials in this
 *      workspace (one credential per (workspace, actor); usually one row).
 *   2. Reads each credential's registered instances from the in-process
 *      registry (populated by the connect-callback path and the admin
 *      refresh-identities endpoint).
 *   3. Builds a fresh MCP server whose tools are the union of every
 *      instance's tools per spec §2's filter table.
 *
 * `tools/list` returns the empty list — not a 4xx — for a workspace that
 * has not connected linkedin-unipile yet (matches the `github-*` pattern's
 * behaviour and lets `get_started`-driven onboarding proceed). Same for a
 * credential whose enumeration hasn't landed yet: registry-empty → no tools,
 * which the next connect / refresh call will populate.
 */

const PROVIDER = 'linkedin-unipile'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

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

	// Fan-out instances for every LinkedIn credential registered in this
	// workspace — NOT filtered by the calling actor. Sessions run under the
	// AGENT actor's Maskin API key (session-manager sets envVars.MASKIN_API_KEY =
	// agent.apiKey), and agents never connect their own LinkedIn — humans do.
	// Filtering on integrations.actorId here (as the earlier version did) meant
	// the query returned zero rows for every agent call, so the auto-injected
	// MCP server correctly registered zero tools even after LinkedIn was
	// connected. The fan-out identity model handles disambiguation at the tool
	// level, not the credential level: every identity is registered as its own
	// MCP instance under `linkedin-{unipileAccSlug}-{identitySlug}` with a
	// scoped tool name (`linkedin-magnus-personal__publish_post`) and a
	// description that names the identity ("AS Magnus Nødegaard"), so an agent
	// picks which identity to act as by picking a tool, not by which credential
	// row happens to be visible. Workspace membership is the auth boundary — the
	// isWorkspaceMember check above already gates access. Matches how
	// session-manager auto-injects (workspace-scoped, no actor filter — see
	// services/session-manager.ts around the active-integrations query) and how
	// Slack's own MCP is scoped.
	const credentialRows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, PROVIDER)))
	const instances = credentialRows.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id))

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId }, instances)

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

	logger.info('LinkedIn MCP request', {
		workspaceId,
		actorId,
		method: (body as { method?: string })?.method,
		instances: instances.length,
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/', (c) => c.text('Method Not Allowed', 405))
app.delete('/', (c) => c.text('Method Not Allowed', 405))

export default app
