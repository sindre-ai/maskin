import type { Database } from '@maskin/db'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createLinkedInMcpServer } from '../lib/integrations/providers/linkedin-unipile/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the LinkedIn (Unipile-backed) provider,
 * mounted at `/api/integrations/linkedin-unipile/mcp`. Sibling of
 * `integrations-slack-mcp.ts`, and deliberately built the same way.
 *
 * Why LinkedIn has its own MCP server rather than tools on the platform
 * `maskin` server: an agent's tool list should mirror what the workspace has
 * connected. Tools that lived on the platform server were present in every
 * agent's list whether or not LinkedIn was connected, and invisible in the
 * agent's MCP servers panel, so there was nothing to attach, detach, or see.
 *
 * NOTE: no credential pre-flight happens here. Slack resolves its workspace
 * bot token in the route because one token serves every caller; LinkedIn's
 * credential is per-actor and is resolved inside each operation, which already
 * returns CREDENTIAL_NOT_CONNECTED as a first-class tool error. Duplicating
 * the lookup here would only change a precise per-tool error into a blanket
 * 400 that hides which actor is unconnected.
 */

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

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId })

	// sessionIdGenerator: undefined = stateless mode. Each POST is
	// self-contained: tools register synchronously before connect(), so
	// initialize / tools-list / tools-call all work without cross-request
	// state. Matches the /mcp and Slack MCP routes.
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
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/', (c) => c.text('Method Not Allowed', 405))
app.delete('/', (c) => c.text('Method Not Allowed', 405))

export default app
