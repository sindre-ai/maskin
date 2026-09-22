import type { Database } from '@maskin/db'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createGoogleMeetMcpServer } from '../lib/integrations/providers/google-meet/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the Google Meet integration, mounted at
 * `/api/integrations/google-meet/mcp`. Sibling of
 * `integrations-linkedin-unipile-mcp.ts` and `integrations-slack-mcp.ts`.
 *
 * Serves both slices registered in `google-meet/mcp-server.ts`: the five
 * read-path tools (list/get conference records, list participants, transcript
 * entries, list recordings) and the two write-path tools
 * (`google_meet__create_space`, `google_meet__create_meet_backed_event`).
 * The write tools resolve the caller-actor's Google Meet token from the
 * workspace's `integrations` row and hit Google. The route itself is dumb —
 * one build-server + connect-transport per POST.
 *
 * A workspace with no connected Meet integration gets an empty tools list
 * (matches the LinkedIn / Slack surfaces — the token layer throws
 * RECONSENT_REQUIRED at tool-call time, but tools/list runs before any tool
 * is called). Onboarding UX surfaces the "connect Google Meet" pre-condition;
 * agent-side callers get a clean error envelope on first tool invocation.
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
