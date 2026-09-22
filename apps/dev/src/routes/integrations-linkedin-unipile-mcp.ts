import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, actors, integrations } from '@maskin/db/schema'
import { getLinkedInMcpInstancesForIntegration, instanceSlug } from '@maskin/mcp/linkedin'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { selfHealLinkedInMcpCredential } from '../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal'
import { createLinkedInMcpServer } from '../lib/integrations/providers/linkedin-unipile/mcp-server'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

/**
 * Streamable-HTTP MCP endpoint for the LinkedIn (LinkedIn-backed) provider.
 * P3-K reshapes this from one shared `/mcp` returning every identity's tools
 * into ONE server PER IDENTITY, keyed by the fan-out instance slug on the URL
 * path. Sibling of `integrations-slack-mcp.ts`.
 *
 * Two endpoints:
 *   POST /api/integrations/linkedin-unipile/mcp/:instanceSlug
 *     — the productive shape. Scoped to a single connected LinkedIn identity
 *       (personal profile or one admined company page) identified by the fan-
 *       out instance slug (e.g. `linkedin-magnus-noeddegaard-personal`).
 *       Every Quick Add button in the agent MCP panel points here. The MCP
 *       server built for the request only exposes THIS identity's tools, so
 *       an agent that has identity-A's mcpServers entry attached physically
 *       cannot call identity-B's verbs.
 *
 *   POST /api/integrations/linkedin-unipile/mcp
 *     — legacy shape (pre-P3-K). Now answers `tools/list` with an empty list
 *       to signal that per-identity scoping is required. Kept as an endpoint
 *       rather than a 404 so any hand-added mcpServers entry still connects
 *       cleanly — the empty tool set is the visible signal to switch to the
 *       per-identity path.
 *
 * Instance-slug matching is done against the in-process registry, which is
 * populated at connect-time (see linkedin-unipile.ts callback) and boot-time
 * (`repopulateLinkedInMcpRegistryOnBoot`). The URL scheme survives restarts:
 * `integrations.unipile_acc_slug` is persisted on the DB row, boot repopulation
 * rebuilds the same instance slugs Unipile enumerates, and self-heal covers
 * a boot that raced the registry.
 */

const PROVIDER = 'linkedin-unipile'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

async function resolveWorkspaceIdentities(
	db: Database,
	workspaceId: string,
): Promise<LinkedInMcpInstanceConfig[]> {
	// P3-C · Filter on `status = 'active'` so a revoked row's still-registered
	// fan-out tools disappear from `tools/list` on the very next request, even
	// if the DELETE hook's `deregisterLinkedInMcpInstancesForIntegration` call
	// has not run. `integrations.status` is the truth (tech principles doc
	// core principle 3); the registry is a performance cache.
	const credentialRows = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			actorId: integrations.actorId,
			createdBy: integrations.createdBy,
			externalId: integrations.externalId,
			status: integrations.status,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, PROVIDER),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)

	// Self-heal any credential whose registry entry is empty. Boot
	// repopulation covers the common restart case; this covers a boot that
	// raced a still-starting Unipile plus any credential whose connect-time
	// enumeration failed and needs a passive retry.
	await Promise.all(credentialRows.map(selfHealLinkedInMcpCredential))

	return credentialRows.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id))
}

/**
 * P3-J · Resolve the caller's read-only tag from `actors.metadata.readOnly`
 * on the calling actor row. When true, the fan-out registers only the
 * read-only allowlist per identity — no write verb reaches the tool surface.
 * Fails safe: a lookup miss or a badly-shaped metadata blob is treated as
 * non-read-only, so an actor's full surface never collapses to nothing on a
 * transient DB read; a leak in the OTHER direction (a read-only-tagged actor
 * seeing a write verb) is the only failure mode gap-17 is about — that path
 * requires `metadata.readOnly === true` to be persisted, and that is what we
 * check for exactly.
 */
async function resolveCallerReadOnly(db: Database, actorId: string): Promise<boolean> {
	try {
		const [row] = await db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)
		const meta = (row?.metadata as Record<string, unknown> | null) ?? null
		return meta?.readOnly === true
	} catch (err) {
		logger.warn('LinkedIn MCP: read-only lookup failed, defaulting to false', {
			actorId,
			error: err instanceof Error ? err.message : String(err),
		})
		return false
	}
}

/**
 * Per-identity MCP endpoint. The mounted-under path (see app-factory.ts) makes
 * `/:instanceSlug` resolve to e.g.
 * `/api/integrations/linkedin-unipile/mcp/linkedin-magnus-noeddegaard-personal`.
 * The server built here exposes exactly the tools of the one instance whose
 * slug matches — cross-identity tool leakage is impossible by construction.
 */
app.post('/:instanceSlug', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id') ?? c.req.header('X-Workspace-Id')
	const requestedSlug = c.req.param('instanceSlug')

	if (!workspaceId) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Missing X-Workspace-Id header',
				undefined,
				'The LinkedIn MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const allInstances = await resolveWorkspaceIdentities(db, workspaceId)
	// Match on the composed instance slug (`linkedin-{acc}-{identity}`) so the
	// URL is stable and human-readable. A slug that no longer resolves — the
	// identity was un-admined, the credential was disconnected — returns an
	// empty tool set rather than a 404; the empty list is the correct signal
	// for the agent to notice the identity is gone, and matches the
	// `github-*` MCP surface's shape.
	const scoped = allInstances.filter((cfg) => instanceSlug(cfg) === requestedSlug)

	// P3-J · Look the caller up ONCE per request and thread `readOnly` into the
	// context; the fan-out's `toolsForIdentity(cfg, {readOnly})` then filters
	// down to the read-only allowlist for every registered instance. Cheap
	// (one PK read) — the /mcp route already runs a workspace-member check
	// and self-heal per request, so one more actor lookup does not shift the
	// path's characteristic.
	const readOnly = await resolveCallerReadOnly(db, actorId)

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId, readOnly }, scoped)

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

	logger.info('LinkedIn MCP request (per-identity)', {
		workspaceId,
		actorId,
		readOnly,
		method: (body as { method?: string })?.method,
		instanceSlug: requestedSlug,
		matched: scoped.length,
	})

	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	return new Response(null, { headers: { 'x-hono-already-sent': '1' } })
})

/**
 * Legacy aggregate endpoint (pre-P3-K). Now serves an empty tool set — the
 * per-identity Quick Add UI writes per-identity URLs (see the /:instanceSlug
 * route above), so nothing under the current UX ever hits this path. Kept as
 * a live endpoint (rather than removing the mount) so a hand-added mcpServers
 * entry that still points here does not fail the transport handshake — it
 * just sees zero tools, which is the correct signal to switch to the per-
 * identity URL.
 */
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
				'The LinkedIn MCP route is workspace-scoped — include the workspace id in the request headers.',
			),
			400,
		)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of this workspace'), 403)
	}

	const mcpServer = createLinkedInMcpServer({ db, actorId, workspaceId }, [])

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

	logger.info('LinkedIn MCP request (aggregate, deprecated)', {
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
