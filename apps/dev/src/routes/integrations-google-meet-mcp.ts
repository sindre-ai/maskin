import type { Database } from '@maskin/db'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createGoogleMeetMcpServer } from '../lib/integrations/providers/google-meet/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the Google Meet write-path tools (bet 947e
 * · task 824f), mounted at `/api/integrations/google-meet/mcp`. Sibling of
 * `integrations-slack-mcp.ts` and `integrations-linkedin-unipile-mcp.ts`.
 *
 * The server itself resolves the Meet OAuth token per-tool-call from the
 * workspace's active `integrations` row, so this route only performs the
 * workspace-membership check and hands off to `createGoogleMeetMcpServer`.
 *
 * Stateless: each POST is self-contained and tools are registered
 * synchronously before `connect()` — same shape as Slack + LinkedIn.
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
				'The Google Meet MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const mcpServer = createGoogleMeetMcpServer({ db, workspaceId, actorId })

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

	logger.info('Google Meet MCP request', {
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
