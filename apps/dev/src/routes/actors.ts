import { generateApiKey, hashPassword } from '@ai-native/auth'
import type { Database } from '@ai-native/db'
import { actors, workspaceMembers, workspaces } from '@ai-native/db/schema'
import { createActorSchema, updateActorSchema, workspaceSettingsSchema } from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import {
	actorListItemSchema,
	actorResponseSchema,
	actorWithKeySchema,
	errorSchema,
	idParamSchema,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST / - Create actor (signup)
const createActorRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Actors'],
	summary: 'Create actor (signup)',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createActorSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Actor created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor with this ID already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createActorRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	// Human users must provide email and password
	if (body.type === 'human') {
		if (!body.email) {
			return c.json(
				createApiError('BAD_REQUEST', 'Email is required for human accounts', [
					{ field: 'email', message: 'Required for human accounts' },
				]),
				400,
			)
		}
		if (!body.password) {
			return c.json(
				createApiError('BAD_REQUEST', 'Password is required for human accounts', [
					{ field: 'password', message: 'Required for human accounts' },
				]),
				400,
			)
		}
	}

	// Generate API key
	const { key } = generateApiKey()

	// Hash password if provided
	const passwordHash = body.password ? await hashPassword(body.password) : undefined

	const [actor] = await db
		.insert(actors)
		.values({
			...(body.id && { id: body.id }),
			type: body.type,
			name: body.name,
			email: body.email,
			apiKey: key,
			passwordHash,
			systemPrompt: body.system_prompt,
			tools: body.tools,
			llmProvider: body.llm_provider,
			llmConfig: body.llm_config,
		})
		.onConflictDoNothing({ target: actors.id })
		.returning()

	if (!actor) {
		if (body.id) {
			return c.json(createApiError('BAD_REQUEST', 'An actor with this ID already exists'), 409)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create actor'), 500)
	}

	// Auto-create personal workspace (default true for humans, false for agents)
	const shouldCreateWorkspace = body.auto_create_workspace ?? body.type === 'human'
	let workspaceId: string | undefined

	if (shouldCreateWorkspace) {
		const defaultSettings = workspaceSettingsSchema.parse({})
		const [workspace] = await db
			.insert(workspaces)
			.values({
				name: `${body.name}'s Workspace`,
				settings: defaultSettings,
				createdBy: actor.id,
			})
			.returning()

		if (workspace) {
			await db.insert(workspaceMembers).values({
				workspaceId: workspace.id,
				actorId: actor.id,
				role: 'owner',
			})

			workspaceId = workspace.id
		}
	}

	// Return actor WITHOUT api_key, but WITH it in the expected response field
	const { apiKey: _, ...actorWithoutKey } = actor
	return c.json(
		{
			...serialize(actorWithoutKey),
			api_key: key,
			...(workspaceId && { workspace_id: workspaceId }),
		} as z.infer<typeof actorWithKeySchema>,
		201,
	)
})

// GET / - List actors
const listActorsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Actors'],
	summary: 'List actors',
	request: {
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(actorListItemSchema) } },
			description: 'List of actors',
		},
	},
})

app.openapi(listActorsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (workspaceId) {
		// List actors in workspace
		const members = await db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				role: workspaceMembers.role,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(eq(workspaceMembers.workspaceId, workspaceId))

		return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
	}

	// List all actors (admin)
	const allActors = await db
		.select({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
		})
		.from(actors)

	return c.json(serializeArray(allActors) as z.infer<typeof actorListItemSchema>[])
})

// GET /:id - Get actor by ID
const getActorRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Get actor by ID',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor found',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(getActorRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const [actor] = await db
		.select({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
		})
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)

	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serialize(actor) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof getActorRoute, Env>)

// PATCH /:id - Update actor
const updateActorRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Update actor',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateActorSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor updated',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(updateActorRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.email && { email: body.email }),
			...(body.system_prompt !== undefined && { systemPrompt: body.system_prompt }),
			...(body.tools !== undefined && { tools: body.tools }),
			...(body.memory !== undefined && { memory: body.memory }),
			...(body.llm_provider !== undefined && { llmProvider: body.llm_provider }),
			...(body.llm_config !== undefined && { llmConfig: body.llm_config }),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			updatedAt: actors.updatedAt,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof updateActorRoute, Env>)

// POST /:id/api-keys - Regenerate API key
const regenerateApiKeyRoute = createRoute({
	method: 'post',
	path: '/{id}/api-keys',
	tags: ['Actors'],
	summary: 'Regenerate API key',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ api_key: z.string() }) } },
			description: 'API key regenerated',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(regenerateApiKeyRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const { key } = generateApiKey()

	const [updated] = await db
		.update(actors)
		.set({ apiKey: key, updatedAt: new Date() })
		.where(eq(actors.id, id))
		.returning({ id: actors.id })

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json({ api_key: key })
}) as RouteHandler<typeof regenerateApiKeyRoute, Env>)

export default app
