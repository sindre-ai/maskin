import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { restoreMaskedToolValues } from '../lib/actor-tools-redaction'
import { encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	CUSTOM_MCP_PROVIDER,
	type CustomMcpServer,
	customMcpServerSchema,
	maskServer,
	readCustomServer,
	summarizeServer,
} from '../lib/integrations/custom-mcp'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

// Custom MCP servers: a workspace's own tool servers, added by hand and shared with chosen
// agents through the same grants as an integration (PUT /api/integrations/:id/grants/:actorId).
// Each is one integrations row (provider 'custom-mcp'); the definition is the encrypted
// credentials blob and `config` carries only a summary every member may see. Removing one is
// DELETE /api/integrations/:id, like any integration.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const nameSchema = z.string().trim().min(1).max(60)

const serverResponseSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	// Env and header values come back as the mask; send the mask back to keep a value.
	server: customMcpServerSchema,
})

const writeBodySchema = z.object({ name: nameSchema, server: customMcpServerSchema }).strict()

const errorResponses = {
	400: { description: 'Invalid', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	409: { description: 'Name taken', content: { 'application/json': { schema: errorSchema } } },
}

function configFor(server: CustomMcpServer): Record<string, unknown> {
	return { custom_mcp: summarizeServer(server) }
}

async function nameTaken(
	db: Database,
	workspaceId: string,
	name: string,
	exceptId?: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
				sql`lower(${integrations.displayName}) = ${name.toLowerCase()}`,
			),
		)
	return rows.some((r) => r.id !== exceptId)
}

async function loadRow(db: Database, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, id),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, CUSTOM_MCP_PROVIDER),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	return row ?? null
}

// ── POST /api/custom-mcp-servers ─────────────────────────────────────────

const addServerRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Add a custom MCP server to the workspace (humans only)',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: writeBodySchema } }, required: true },
	},
	responses: {
		201: {
			description: 'Added. No agent has it until it is granted',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		...errorResponses,
	},
})

app.openapi(addServerRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can add a tool server'), 403)
	}
	const { name, server } = c.req.valid('json')
	if (await nameTaken(db, workspaceId, name)) {
		return c.json(createApiError('CONFLICT', 'A tool server with that name already exists'), 409)
	}

	const created = await db.transaction(async (tx) => {
		const id = randomUUID()
		const [row] = await tx
			.insert(integrations)
			.values({
				id,
				// Unique per server: the index on (workspace, actor, provider) would otherwise let a
				// workspace hold only one.
				externalId: id,
				workspaceId,
				provider: CUSTOM_MCP_PROVIDER,
				status: 'active',
				credentials: encrypt(JSON.stringify({ server })),
				config: configFor(server),
				displayName: name,
				// Explicit grant only: a new server reaches no agent until a person picks them.
				defaultAgentAccess: 'none',
				createdBy: callerId,
			})
			.returning({ id: integrations.id })
		if (!row) throw new Error('Insert returned no row')
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'created',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: CUSTOM_MCP_PROVIDER, name },
		})
		return row
	})

	return c.json({ id: created.id, name, server: maskServer(server) }, 201)
}) as RouteHandler<typeof addServerRoute, Env>)

// ── GET /api/custom-mcp-servers/:id ──────────────────────────────────────

const getServerRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['integrations'],
	summary: 'Read a custom MCP server, with secret values masked',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description: 'The server',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		404: errorResponses[404],
	},
})

app.openapi(getServerRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const row = await loadRow(db, workspaceId, id)
	const server = row ? readCustomServer(row) : null
	if (!row || !server) return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	return c.json({ id, name: row.displayName ?? '', server: maskServer(server) }, 200)
}) as RouteHandler<typeof getServerRoute, Env>)

// ── PUT /api/custom-mcp-servers/:id ──────────────────────────────────────

const updateServerRoute = createRoute({
	method: 'put',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Change a custom MCP server (humans only)',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: writeBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'Saved. Applies to sessions started after this call',
			content: { 'application/json': { schema: serverResponseSchema } },
		},
		...errorResponses,
	},
})

app.openapi(updateServerRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person can change a tool server'), 403)
	}
	const { id } = c.req.valid('param')
	const { name, server: incoming } = c.req.valid('json')

	const row = await loadRow(db, workspaceId, id)
	const stored = row ? readCustomServer(row) : null
	if (!row || !stored) return c.json(createApiError('NOT_FOUND', 'Tool server not found'), 404)
	if (
		row.createdBy !== callerId &&
		!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))
	) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only the person who added this or a workspace admin can change it',
			),
			403,
		)
	}
	if (await nameTaken(db, workspaceId, name, id)) {
		return c.json(createApiError('CONFLICT', 'A tool server with that name already exists'), 409)
	}

	// A value read back masked keeps what is stored, but only while the command or URL is
	// unchanged: otherwise a mask could be used to send the stored secret somewhere new.
	const { tools, unresolved } = restoreMaskedToolValues(
		{ mcpServers: { s: incoming } },
		{ mcpServers: { s: stored } },
	)
	if (unresolved.length > 0) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'Re-enter the secret values: they cannot be kept when the command or URL changes',
			),
			400,
		)
	}
	const server = customMcpServerSchema.parse((tools.mcpServers as { s: unknown }).s)

	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({
				credentials: encrypt(JSON.stringify({ server })),
				config: configFor(server),
				displayName: name,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, id))
		await recordEvent(tx, {
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { provider: CUSTOM_MCP_PROVIDER, name, change: 'tool_server' },
		})
	})

	return c.json({ id, name, server: maskServer(server) }, 200)
}) as RouteHandler<typeof updateServerRoute, Env>)

export default app
