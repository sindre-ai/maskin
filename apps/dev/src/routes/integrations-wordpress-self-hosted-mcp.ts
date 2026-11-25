import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { WORDPRESS_SELF_HOSTED_PROVIDER } from '../lib/integrations/providers/wordpress-self-hosted/config'
import { createWordPressMcpServer } from '../lib/integrations/providers/wordpress-self-hosted/mcp-server'
import { toolGateFor } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for a self-hosted WordPress site, mounted at
 * `/api/integrations/wordpress-self-hosted/mcp`. Same shape as `integrations-deepdots-mcp.ts`: the
 * route looks up only the integration id and site label, the per-agent tool gate decides what the
 * caller may run (reads for Read, writes only for Read and write), and the tools in
 * `wordpress-self-hosted/mcp-server.ts` read the saved login server-side.
 *
 * A workspace with no active connection still lists the tools; each call then answers NOT_CONNECTED.
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
				'The WordPress MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	// Only the id and the site label are needed here. The credential is not read here. Oldest
	// connection first, the same rule as the credential lookup.
	const [site] = await db
		.select({ id: integrations.id, externalId: integrations.externalId })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, WORDPRESS_SELF_HOSTED_PROVIDER),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(asc(integrations.createdAt), asc(integrations.id))
		.limit(1)
	const integrationId = site?.id ?? null
	const gate = await toolGateFor(db, {
		workspaceId,
		actorId,
		integrationId,
		provider: WORDPRESS_SELF_HOSTED_PROVIDER,
		providerLabel: 'WordPress',
		sessionId: c.get('maskinSessionId'),
	})
	const mcpServer = createWordPressMcpServer(
		{
			db,
			workspaceId,
			actorId,
			sessionId: c.get('maskinSessionId'),
			integrationId,
			siteLabel: site?.externalId ?? null,
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

	logger.info('WordPress MCP request', {
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
