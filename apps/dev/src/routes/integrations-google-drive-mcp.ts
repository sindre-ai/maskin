import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { classifyMcpClient } from '../lib/analytics/mcp-client'
import { normalizeActorType } from '../lib/analytics/mcp-tool-calls'
import { createApiError } from '../lib/errors'
import { findIntegrationRow } from '../lib/integrations/lookup'
import { createGoogleDriveMcpServer } from '../lib/integrations/providers/google-drive/mcp-server'
import { GOOGLE_DRIVE_PROVIDER } from '../lib/integrations/providers/google-drive/token'
import { readContextFor } from '../lib/integrations/read-context'
import { toolGateFor } from '../lib/integrations/tool-gate'
import { logger } from '../lib/logger'
import { isWorkspaceWriter } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the Google Drive integration, mounted at
 * /api/integrations/google-drive/mcp. Sibling of the Meet / Slack / LinkedIn MCP
 * routes: the caller authenticates with the Maskin API key (so the Google token
 * never enters the agent container), names the workspace in X-Workspace-Id, and
 * must be able to write in it. The Drive token is resolved server-side from that
 * workspace's own integrations row, so workspace B can never reach workspace A's
 * credential.
 *
 * The route is dumb: one build-server + connect-transport per POST. A workspace
 * with no connected Drive gets a clean INTEGRATION_MISSING envelope when a tool
 * is called. With a connected Drive, each tool is gated on the calling agent's
 * access level (Read, Read & write), the same as Meet.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
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
				'The Google Drive MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceWriter(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	// The same row the token lookup picks (the read context widens it exactly as the token read
	// does), so the gate judges the connection the tool will use. The credential stays sealed.
	const drive = await findIntegrationRow(db, workspaceId, GOOGLE_DRIVE_PROVIDER, null, {
		ctx: readContextFor(actorId),
	})
	const gate = await toolGateFor(db, {
		workspaceId,
		actorId,
		integrationId: drive?.id ?? null,
		provider: GOOGLE_DRIVE_PROVIDER,
		providerLabel: 'Google Drive',
	})
	const mcpServer = createGoogleDriveMcpServer(
		{
			db,
			workspaceId,
			actorId,
			sessionId: c.req.header('x-maskin-session-id') || undefined,
			client: classifyMcpClient(c.req.header('user-agent')),
			actorType: normalizeActorType(c.get('actorType')),
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
