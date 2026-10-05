import type { Database } from '@maskin/db'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createGoogleDriveMcpServer } from '../lib/integrations/providers/google-drive/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the Google Drive integration, mounted at
 * /api/integrations/google-drive/mcp. Sibling of the Meet / Slack / LinkedIn MCP
 * routes: the caller authenticates with the Maskin API key (so the Google token
 * never enters the agent container), names the workspace in X-Workspace-Id, and
 * must be a member of it. The Drive token is resolved server-side from that
 * workspace's own integrations row, so workspace B can never reach workspace A's
 * credential.
 *
 * The route is dumb: one build-server + connect-transport per POST. A workspace
 * with no connected Drive gets a clean INTEGRATION_MISSING envelope when a tool
 * is called.
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
				'The Google Drive MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const mcpServer = createGoogleDriveMcpServer({
		db,
		workspaceId,
		actorId,
		sessionId: c.req.header('x-maskin-session-id') || undefined,
	})

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

	logger.info('Google Drive MCP request', {
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
