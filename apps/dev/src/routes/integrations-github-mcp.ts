import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createGithubMcpServer } from '../lib/integrations/providers/github/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the GitHub provider, mounted at
 * `/api/integrations/github/mcp/:integrationId`. Replaces the per-org stdio
 * subprocess (`npx @modelcontextprotocol/server-github`) that session-manager
 * used to auto-inject into every session's MCP config — that subprocess baked
 * a 1-hour installation token into its env at spawn and silently 401'd on any
 * write past the mint mark. Sibling of `integrations-slack-mcp.ts` and
 * `integrations-linkedin-unipile-mcp.ts`, deliberately built the same way.
 *
 * The URL is per-integration (`:integrationId`) so a workspace with multiple
 * GitHub App installations (multi-org) gets one MCP entry per install, each
 * targeted at that install's tokens. Preserves the `github-<owner>` naming
 * convention the log classifier expects — the entry name in session-manager
 * still carries the owner login even though the URL carries the integration
 * id under it.
 *
 * `X-Workspace-Id` is required and validated against the calling actor's
 * workspace membership; `:integrationId` must be an active github integration
 * inside that workspace, otherwise the request is rejected with 404 before any
 * MCP session is established.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

app.post('/:integrationId', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')
	const integrationId = c.req.param('integrationId')

	if (!workspaceId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Missing X-Workspace-Id header',
				undefined,
				'The GitHub MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const [integration] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.id, integrationId),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'github'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) {
		return c.json(
			createApiError('NOT_FOUND', 'Active GitHub integration not found for this workspace'),
			404,
		)
	}

	const mcpServer = createGithubMcpServer({
		db,
		integrationId: integration.id,
		workspaceId,
		actorId,
	})

	// sessionIdGenerator: undefined = stateless mode. Each POST is self-contained:
	// tools register synchronously before connect(), so initialize/tools-list/
	// tools-call all work without cross-request state. Matches Slack + LinkedIn
	// MCP routes.
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

	logger.info('GitHub MCP request', {
		workspaceId,
		actorId,
		integrationId: integration.id,
		method: (body as { method?: string })?.method,
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/:integrationId', (c) => c.text('Method Not Allowed', 405))
app.delete('/:integrationId', (c) => c.text('Method Not Allowed', 405))

export default app
