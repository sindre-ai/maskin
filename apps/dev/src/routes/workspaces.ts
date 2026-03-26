import type { Database } from '@ai-native/db'
import { actors, objects, workspaceMembers, workspaces } from '@ai-native/db/schema'
import {
	createWorkspaceSchema,
	getObjectTypes,
	objectTypeDefinitionSchema,
	updateWorkspaceSchema,
	workspaceSettingsSchema,
	workspaceTemplates,
} from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { count, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema, idParamSchema, workspaceResponseSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const memberResponseSchema = z.object({
	actorId: z.string().uuid(),
	role: z.string(),
	joinedAt: z.string().nullable(),
	name: z.string(),
	type: z.string(),
})

const addMemberBodySchema = z.object({
	actor_id: z.string().uuid(),
	role: z.string().optional(),
})

const workspaceWithRoleSchema = workspaceResponseSchema.extend({
	role: z.string(),
})

const app = new OpenAPIHono<Env>()

// POST /api/workspaces
const createWorkspaceRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['workspaces'],
	summary: 'Create workspace',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Workspace created',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createWorkspaceRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	let baseSettings = body.settings ?? {}
	const template = body.template ? workspaceTemplates[body.template] : undefined
	if (template) {
		baseSettings = {
			...baseSettings,
			object_types: template.object_types,
			relationship_types: template.relationship_types,
		}
	}
	const settings = workspaceSettingsSchema.parse(baseSettings)

	const [workspace] = await db
		.insert(workspaces)
		.values({
			name: body.name,
			settings,
			createdBy: actorId,
		})
		.returning()

	if (!workspace) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace'), 500)
	}

	// Auto-add creator as owner
	await db.insert(workspaceMembers).values({
		workspaceId: workspace.id,
		actorId,
		role: 'owner',
	})

	return c.json(serialize(workspace) as z.infer<typeof workspaceResponseSchema>, 201)
})

// GET /api/workspaces
const listWorkspacesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['workspaces'],
	summary: 'List workspaces for current actor',
	responses: {
		200: {
			description: 'List of workspaces',
			content: { 'application/json': { schema: z.array(workspaceWithRoleSchema) } },
		},
	},
})

app.openapi(listWorkspacesRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const results = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			settings: workspaces.settings,
			role: workspaceMembers.role,
			createdAt: workspaces.createdAt,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
		.where(eq(workspaceMembers.actorId, actorId))

	return c.json(serializeArray(results) as z.infer<typeof workspaceWithRoleSchema>[])
})

// PATCH /api/workspaces/:id
const updateWorkspaceRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['workspaces'],
	summary: 'Update workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Workspace updated',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateWorkspaceRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.settings) {
		// Merge settings with existing
		const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
		if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		updateData.settings = {
			...(existing.settings as object),
			...body.settings,
		}
	}

	const [updated] = await db
		.update(workspaces)
		.set(updateData)
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceRoute, Env>)

// POST /api/workspaces/:id/members
const addMemberRoute = createRoute({
	method: 'post',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'Add member to workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: addMemberBodySchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Member added',
			content: { 'application/json': { schema: z.object({ added: z.boolean() }) } },
		},
	},
})

app.openapi(addMemberRoute, async (c) => {
	const db = c.get('db')
	const { id: workspaceId } = c.req.valid('param')
	const { actor_id, role } = c.req.valid('json')

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: actor_id,
		role: role || 'member',
	})

	return c.json({ added: true }, 201)
})

// GET /api/workspaces/:id/members
const listMembersRoute = createRoute({
	method: 'get',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'List workspace members',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'List of members',
			content: { 'application/json': { schema: z.array(memberResponseSchema) } },
		},
	},
})

app.openapi(listMembersRoute, async (c) => {
	const db = c.get('db')
	const { id: workspaceId } = c.req.valid('param')

	const members = await db
		.select({
			actorId: workspaceMembers.actorId,
			role: workspaceMembers.role,
			joinedAt: workspaceMembers.joinedAt,
			name: actors.name,
			type: actors.type,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	return c.json(serializeArray(members) as z.infer<typeof memberResponseSchema>[])
})

// GET /api/workspaces/:id/types
const listTypesRoute = createRoute({
	method: 'get',
	path: '/{id}/types',
	tags: ['workspaces'],
	summary: 'List object types for workspace',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Object type definitions',
			content: { 'application/json': { schema: z.array(objectTypeDefinitionSchema) } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listTypesRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404) as never

	return c.json(getObjectTypes(workspace.settings as Parameters<typeof getObjectTypes>[0]))
}) as RouteHandler<typeof listTypesRoute, Env>)

const typeSlugParamSchema = z.object({ id: z.string().uuid(), slug: z.string() })

// PUT /api/workspaces/:id/types/:slug
const upsertTypeRoute = createRoute({
	method: 'put',
	path: '/{id}/types/{slug}',
	tags: ['workspaces'],
	summary: 'Create or update an object type definition',
	request: {
		params: typeSlugParamSchema,
		body: { content: { 'application/json': { schema: objectTypeDefinitionSchema } } },
	},
	responses: {
		200: {
			description: 'Type upserted',
			content: { 'application/json': { schema: objectTypeDefinitionSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(upsertTypeRoute, (async (c) => {
	const db = c.get('db')
	const { id, slug } = c.req.valid('param')
	const body = c.req.valid('json')

	const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	const settings = workspace.settings as Parameters<typeof getObjectTypes>[0]
	const existingTypes = getObjectTypes(settings)
	const typeDef = { ...body, slug }
	const updated = existingTypes.some((t) => t.slug === slug)
		? existingTypes.map((t) => (t.slug === slug ? typeDef : t))
		: [...existingTypes, typeDef]

	const [updatedWorkspace] = await db
		.update(workspaces)
		.set({ settings: { ...(workspace.settings as object), object_types: updated }, updatedAt: new Date() })
		.where(eq(workspaces.id, id))
		.returning()

	if (!updatedWorkspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	return c.json(typeDef as z.infer<typeof objectTypeDefinitionSchema>)
}) as RouteHandler<typeof upsertTypeRoute, Env>)

// DELETE /api/workspaces/:id/types/:slug
const deleteTypeRoute = createRoute({
	method: 'delete',
	path: '/{id}/types/{slug}',
	tags: ['workspaces'],
	summary: 'Remove an object type definition',
	request: { params: typeSlugParamSchema },
	responses: {
		200: {
			description: 'Type removed',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean(), objectCount: z.number() }) } },
		},
		400: {
			description: 'Type has existing objects',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteTypeRoute, (async (c) => {
	const db = c.get('db')
	const { id, slug } = c.req.valid('param')
	const force = c.req.query('force') === 'true'

	const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// Count objects of this type
	const [countResult] = await db
		.select({ n: count() })
		.from(objects)
		.where(eq(objects.type, slug))

	const objectCount = Number(countResult?.n ?? 0)
	if (objectCount > 0 && !force) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Cannot delete type '${slug}': ${objectCount} object(s) exist. Use ?force=true to delete anyway.`,
			),
			400,
		)
	}

	const settings = workspace.settings as Parameters<typeof getObjectTypes>[0]
	const existingTypes = getObjectTypes(settings)
	const updated = existingTypes.filter((t) => t.slug !== slug)

	await db
		.update(workspaces)
		.set({ settings: { ...(workspace.settings as object), object_types: updated }, updatedAt: new Date() })
		.where(eq(workspaces.id, id))

	return c.json({ deleted: true, objectCount })
}) as RouteHandler<typeof deleteTypeRoute, Env>)

export default app
