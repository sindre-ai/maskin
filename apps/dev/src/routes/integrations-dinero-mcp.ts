import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createDineroMcpServer } from '../lib/integrations/providers/dinero/mcp-server'
import { toolGateFor } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for Dinero, mounted at `/api/integrations/dinero/mcp`. Same
 * shape as `integrations-deepdots-mcp.ts`: the route looks up only the integration id, the
 * per-agent tool gate decides what the caller may run, and the tools in
 * `dinero/mcp-server.ts` resolve the keys and token server-side.
 *
 * A workspace with no active Dinero integration still lists the tools; each call then
 * answers NOT_CONNECTED.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		maskinSessionId?: string
		storageProvider: StorageProvider
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
				'The Dinero MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	// Only the id is needed, to look up this agent's access. The keys are not read here.
	// Newest first, so a reconnect wins over an older row that is still active.
	const [dinero] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'dinero'),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(desc(integrations.createdAt))
		.limit(1)
	const integrationId = dinero?.id ?? null
	const sessionId = c.get('maskinSessionId')
	const gate = await toolGateFor(db, {
		workspaceId,
		actorId,
		integrationId,
		provider: 'dinero',
		providerLabel: 'Dinero',
		sessionId,
	})
	const mcpServer = createDineroMcpServer(
		{
			db,
			workspaceId,
			actorId,
			sessionId,
			integrationId,
			storage: c.get('storageProvider'),
		},
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

	logger.info('Dinero MCP request', {
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
