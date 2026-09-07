import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { and, eq, isNull } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	type InstallInput,
	installMarketplaceItem,
	listLiveInstallations,
} from '../services/marketplace-install'
import { uninstallMarketplaceItem } from '../services/marketplace-uninstall'

/**
 * Marketplace install/uninstall HTTP surface — the routes named by
 * Marketplace tech spec §6.3–§6.5. Mounted alongside marketplace-loops.ts on
 * the /api/marketplace prefix; the paths here do not collide with the loop
 * catalog routes there.
 *
 * All routes are behind the existing per-key `apiKeyAuth` middleware attached
 * in app-factory. Install and uninstall additionally require workspace
 * membership (`assertMember` equivalent — the shared helper is
 * `isWorkspaceMember` in `../lib/workspace-auth`).
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── Schemas ────────────────────────────────────────────────────────────────

const itemKindSchema = z.enum(['loop', 'agent', 'skill', 'mcp_server'])

const installBodySchema = z.object({
	item_kind: itemKindSchema,
	catalog_id: z.string().uuid(),
	workspace_id: z.string().uuid(),
})

const installationResponseSchema = z.object({
	id: z.string().uuid(),
	workspace_id: z.string().uuid(),
	item_kind: itemKindSchema,
	catalog_id: z.string().uuid(),
	catalog_slug: z.string(),
	installed_loop_id: z.string().uuid().nullable(),
	actor_id: z.string().uuid().nullable(),
	workspace_skill_id: z.string().uuid().nullable(),
	mcp_installation_id: z.string().uuid().nullable(),
	trigger_ids: z.array(z.string().uuid()),
	source: z.string(),
	installed_by_actor_id: z.string().uuid(),
	installed_at: z.string(),
	uninstalled_at: z.string().nullable(),
})

const requiresNotMetSchema = z.object({
	error: z.literal('requires_not_met'),
	missing: z.object({
		integrations: z.array(z.string()).optional(),
		mcp_installations: z.array(z.string()).optional(),
	}),
})

const installationsListResponseSchema = z.object({
	installations: z.array(installationResponseSchema),
})

const idParamSchema = z.object({
	id: z.string().uuid(),
})

const workspaceQuerySchema = z.object({
	workspace_id: z.string().uuid(),
})

function serialize(row: Awaited<ReturnType<typeof listLiveInstallations>>[number]) {
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		item_kind: row.itemKind as z.infer<typeof itemKindSchema>,
		catalog_id: row.catalogId,
		catalog_slug: row.catalogSlug,
		installed_loop_id: row.installedLoopId,
		actor_id: row.actorId,
		workspace_skill_id: row.workspaceSkillId,
		mcp_installation_id: row.mcpInstallationId,
		trigger_ids: Array.isArray(row.triggerIds) ? (row.triggerIds as string[]) : [],
		source: row.source,
		installed_by_actor_id: row.installedByActorId,
		installed_at: row.installedAt?.toISOString() ?? new Date().toISOString(),
		uninstalled_at: row.uninstalledAt ? row.uninstalledAt.toISOString() : null,
	}
}

// ── POST /api/marketplace/install ─────────────────────────────────────────

const installRoute = createRoute({
	method: 'post',
	path: '/install',
	tags: ['Marketplace'],
	summary: 'Install a Marketplace catalog item into a workspace',
	request: {
		body: { content: { 'application/json': { schema: installBodySchema } } },
	},
	responses: {
		201: {
			description: 'New install created',
			content: { 'application/json': { schema: installationResponseSchema } },
		},
		200: {
			description: 'Already installed — idempotent success',
			content: { 'application/json': { schema: installationResponseSchema } },
		},
		403: { description: 'Actor is not a workspace member' },
		404: { description: 'Catalog item not found' },
		409: { description: 'Concurrent install race' },
		424: {
			description: 'Required integrations / MCP installations not connected',
			content: { 'application/json': { schema: requiresNotMetSchema } },
		},
		501: { description: 'MCP Registry install path not yet available' },
	},
})

app.openapi(installRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json') as z.infer<typeof installBodySchema>

	if (!(await isWorkspaceMember(db, actorId, body.workspace_id))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of the workspace'), 403)
	}

	const input: InstallInput = {
		itemKind: body.item_kind,
		catalogId: body.catalog_id,
		workspaceId: body.workspace_id,
		installedByActorId: actorId,
	}

	const result = await installMarketplaceItem(db, input)

	if (result.status === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Catalog item not found'), 404)
	}
	if (result.status === 'requires_not_met') {
		return c.json({ error: 'requires_not_met' as const, missing: result.missing }, 424)
	}
	if (result.status === 'mcp_registry_unavailable') {
		return c.json(
			createApiError(
				'NOT_IMPLEMENTED',
				'MCP server install routes to the MCP Registry, which is not yet available',
			),
			501,
		)
	}
	if (result.status === 'already_installed') {
		return c.json(serialize(result.installation), 200)
	}
	return c.json(serialize(result.installation), 201)
}) as RouteHandler<typeof installRoute, Env>)

// ── DELETE /api/marketplace/installations/{id} ─────────────────────────────

const uninstallRoute = createRoute({
	method: 'delete',
	path: '/installations/{id}',
	tags: ['Marketplace'],
	summary: 'Uninstall a Marketplace item',
	request: {
		params: idParamSchema,
		query: workspaceQuerySchema,
	},
	responses: {
		204: { description: 'Uninstall succeeded' },
		403: { description: 'Actor is not a workspace member' },
		404: { description: 'Installation not found or not owned by the workspace' },
		409: { description: 'Already uninstalled' },
		501: { description: 'MCP Registry uninstall path not yet available' },
	},
})

app.openapi(uninstallRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param') as z.infer<typeof idParamSchema>
	const { workspace_id: workspaceId } = c.req.valid('query') as z.infer<typeof workspaceQuerySchema>

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of the workspace'), 403)
	}

	const result = await uninstallMarketplaceItem(db, {
		installationId: id,
		workspaceId,
		uninstalledByActorId: actorId,
	})

	if (result.status === 'not_found' || result.status === 'not_owned') {
		return c.json(createApiError('NOT_FOUND', 'Installation not found'), 404)
	}
	if (result.status === 'already_uninstalled') {
		return c.json(createApiError('CONFLICT', 'Installation already uninstalled'), 409)
	}
	if (result.status === 'mcp_registry_unavailable') {
		return c.json(
			createApiError(
				'NOT_IMPLEMENTED',
				'MCP server uninstall routes to the MCP Registry, which is not yet available',
			),
			501,
		)
	}
	return c.body(null, 204)
}) as RouteHandler<typeof uninstallRoute, Env>)

// ── GET /api/marketplace/installations ─────────────────────────────────────

const listRoute = createRoute({
	method: 'get',
	path: '/installations',
	tags: ['Marketplace'],
	summary: 'List live Marketplace installations for a workspace',
	request: {
		query: workspaceQuerySchema,
	},
	responses: {
		200: {
			description: 'List of live installations',
			content: { 'application/json': { schema: installationsListResponseSchema } },
		},
		403: { description: 'Actor is not a workspace member' },
	},
})

app.openapi(listRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { workspace_id: workspaceId } = c.req.valid('query') as z.infer<typeof workspaceQuerySchema>

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Actor is not a member of the workspace'), 403)
	}

	const installations = await listLiveInstallations(db, workspaceId)
	return c.json({ installations: installations.map(serialize) }, 200)
}) as RouteHandler<typeof listRoute, Env>)

export default app
