import type { Database } from '@maskin/db'
import { actors, workspaces } from '@maskin/db/schema'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { resolveSlackBotToken } from '../lib/integrations/providers/slack/bot-token'
import { createSlackMcpServer } from '../lib/integrations/providers/slack/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

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
				'The Slack MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Calling actor not found'), 404)
	}
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const resolved = await resolveSlackBotToken(db, workspaceId)
	if (!resolved) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Slack integration is not connected with a workspace bot token',
				undefined,
				'Reconnect Slack so the install grants chat:write + chat:write.customize on a bot (xoxb-) token.',
			),
			400,
		)
	}

	const agentLabel = `${actor.name} · in ${workspace.name}`
	const machineIconUrl = process.env.MASKIN_MACHINE_ICON_URL?.trim() || undefined

	const mcpServer = createSlackMcpServer({
		botToken: resolved.botToken,
		agentLabel,
		machineIconUrl,
		workspaceId,
		actorId,
		slackTeamId: resolved.slackTeamId,
	})

	// sessionIdGenerator: undefined = stateless mode. Each POST is self-contained:
	// tools are registered synchronously before connect(), so initialize/tools-list/
	// tools-call all work without cross-request state. Matches the /mcp pattern.
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

	logger.info('Slack MCP request', {
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
