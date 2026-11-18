import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createYoutubeMcpServer } from '../lib/integrations/providers/youtube/mcp-server'
import { toolGateFor } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the YouTube integration, mounted at
 * `/api/integrations/youtube/mcp`. Copy of `integrations-google-meet-mcp.ts`: the Meet route is
 * not generic, it imports its own server factory.
 *
 * The route only looks up the integration id, to judge this agent's access with the per-agent
 * tool gate. The credential is read inside the tool server, through the Keychain. A workspace with
 * no connected YouTube integration still lists the tools; each call then answers NOT_CONNECTED.
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
				'The YouTube MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	// Only the id is needed, to look up this agent's access. The credential is not read here.
	const [youtube] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'youtube'),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.limit(1)
	const gate = await toolGateFor(db, {
		workspaceId,
		actorId,
		integrationId: youtube?.id ?? null,
		provider: 'youtube',
		providerLabel: 'YouTube',
	})
	const mcpServer = createYoutubeMcpServer(
		{ db, workspaceId, actorId, sessionId: c.get('maskinSessionId') },
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

	logger.info('YouTube MCP request', {
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
