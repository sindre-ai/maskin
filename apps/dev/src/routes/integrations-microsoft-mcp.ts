import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createMicrosoftMcpServer } from '../lib/integrations/providers/microsoft/mcp-server'
import { toolGateFor } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for Microsoft, mounted at `/api/integrations/microsoft/mcp`.
 * Same shape as `integrations-deepdots-mcp.ts`: the route looks up only the integration id,
 * the per-agent tool gate decides what the caller may run, and the three read-only Outlook
 * calendar tools in `microsoft/mcp-server.ts` resolve the token server-side.
 *
 * A workspace with no active Microsoft integration still lists the tools; each call then
 * answers NOT_CONNECTED.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		maskinSessionId?: string
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
				'The Microsoft MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	// Only the id is needed, to look up this agent's access. The credential is not read here.
	// Newest first, so a reconnect wins over an older row that is still active.
	const [microsoft] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'microsoft'),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(desc(integrations.createdAt))
		.limit(1)
	const integrationId = microsoft?.id ?? null
	const gate = await toolGateFor(db, {
		workspaceId,
		actorId,
		integrationId,
		provider: 'microsoft',
		providerLabel: 'Microsoft',
	})
	const mcpServer = createMicrosoftMcpServer(
		{ db, workspaceId, actorId, sessionId: c.get('maskinSessionId'), integrationId },
		gate,
	)

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

	logger.info('Microsoft MCP request', {
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
