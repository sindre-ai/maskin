import type { Database } from '@maskin/db'
import { actors, integrations, workspaces } from '@maskin/db/schema'
import { ApiErrorCode } from '@maskin/shared'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { createGoogleCalendarMcpServer } from '../lib/integrations/mcp/google-calendar/mcp-server'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const PROVIDER = 'google-calendar'
const tokenManager = new TokenManager()

/**
 * Look up the active `google-calendar` integration for the workspace and
 * return the integration id alongside the externalId (= connected Google
 * email). Returns null when there is no active row — the route translates
 * that into a 400 so the agent gets a clear "reconnect" error.
 */
async function resolveActiveIntegration(
	db: Database,
	workspaceId: string,
): Promise<{ integrationId: string; connectedEmail: string } | null> {
	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) return null
	return {
		integrationId: integration.id,
		connectedEmail: integration.externalId ?? '',
	}
}

const app = new Hono<Env>()

app.post('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')
	const idempotencyKey =
		c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key') ?? undefined

	if (!workspaceId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Missing X-Workspace-Id header',
				undefined,
				'The Google Calendar MCP route is workspace-scoped — include the workspace id in the request headers.',
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

	const integration = await resolveActiveIntegration(db, workspaceId)
	if (!integration) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Google Calendar is not connected for this workspace',
				undefined,
				'Connect Google Calendar from Settings → Integrations before invoking the write tools.',
			),
			400,
		)
	}

	let accessToken: string
	try {
		const provider = getProvider(PROVIDER)
		accessToken = await tokenManager.getValidToken(db, integration.integrationId, provider)
	} catch (err) {
		// Treat any token-resolution failure as auth_revoked so the agent gets
		// the same opaque code regardless of where the upstream broke. The
		// integration row flip + revoked detection live in T2 — here we just
		// surface that the agent can't proceed without a reconnect.
		logger.warn('Google Calendar token resolution failed', {
			workspaceId,
			actorId,
			integrationId: integration.integrationId,
			error: String(err),
		})
		return c.json(
			createApiError(
				ApiErrorCode.AUTH_REVOKED,
				'Google Calendar grant is no longer valid — reconnect the integration.',
			),
			401,
		)
	}

	const mcpServer = createGoogleCalendarMcpServer({
		accessToken,
		workspaceId,
		actorId,
		idempotencyKey,
		connectedEmail: integration.connectedEmail,
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

	logger.info('Google Calendar MCP request', {
		workspaceId,
		actorId,
		method: (body as { method?: string })?.method,
		idempotent: Boolean(idempotencyKey),
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

app.get('/', (c) => c.text('Method Not Allowed', 405))
app.delete('/', (c) => c.text('Method Not Allowed', 405))

export default app
