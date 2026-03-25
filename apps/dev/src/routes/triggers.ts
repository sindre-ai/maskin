import type { Database } from '@ai-native/db'
import { triggers } from '@ai-native/db/schema'
import { createTriggerSchema, updateTriggerSchema } from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logEvent } from '../lib/log-event'
import {
	errorSchema,
	idParamSchema,
	triggerResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST /api/triggers
const createTriggerRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['triggers'],
	summary: 'Create a trigger',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createTriggerSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Trigger created',
			content: { 'application/json': { schema: triggerResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createTriggerRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const body = c.req.valid('json')

	const [created] = await db
		.insert(triggers)
		.values({
			...(body.id && { id: body.id }),
			workspaceId,
			name: body.name,
			type: body.type,
			config: body.config,
			actionPrompt: body.action_prompt,
			targetActorId: body.target_actor_id,
			enabled: body.enabled,
			createdBy: actorId,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create trigger'), 500)
	}

	await logEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'trigger',
		entityId: created.id,
		data: created,
	})

	return c.json(serialize(created) as z.infer<typeof triggerResponseSchema>, 201)
})

// GET /api/triggers
const listTriggersRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['triggers'],
	summary: 'List triggers in workspace',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of triggers',
			content: { 'application/json': { schema: z.array(triggerResponseSchema) } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listTriggersRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const results = await db.select().from(triggers).where(eq(triggers.workspaceId, workspaceId))

	return c.json(serializeArray(results) as z.infer<typeof triggerResponseSchema>[])
}) as RouteHandler<typeof listTriggersRoute, Env>)

// PATCH /api/triggers/:id
const updateTriggerRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['triggers'],
	summary: 'Update a trigger',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateTriggerSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Trigger updated',
			content: { 'application/json': { schema: triggerResponseSchema } },
		},
		404: {
			description: 'Trigger not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateTriggerRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	// Verify trigger exists and actor is a workspace member
	const [trigger] = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1)
	if (!trigger || !(await isWorkspaceMember(db, actorId, trigger.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Trigger not found'), 404)
	}

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.config) updateData.config = body.config
	if (body.action_prompt) updateData.actionPrompt = body.action_prompt
	if (body.target_actor_id) updateData.targetActorId = body.target_actor_id
	if (body.enabled !== undefined) updateData.enabled = body.enabled

	const [updated] = await db.update(triggers).set(updateData).where(eq(triggers.id, id)).returning()

	if (!updated) return c.json(createApiError('NOT_FOUND', 'Trigger not found'), 404)

	await logEvent(db, {
		workspaceId: trigger.workspaceId,
		actorId,
		action: 'updated',
		entityType: 'trigger',
		entityId: id,
		data: { previous: trigger, updated },
	})

	return c.json(serialize(updated) as z.infer<typeof triggerResponseSchema>)
}) as RouteHandler<typeof updateTriggerRoute, Env>)

// DELETE /api/triggers/:id
const deleteTriggerRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['triggers'],
	summary: 'Delete a trigger',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Trigger deleted',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: {
			description: 'Trigger not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteTriggerRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1)
	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Trigger not found'), 404)
	}

	await db.delete(triggers).where(eq(triggers.id, id))

	await logEvent(db, {
		workspaceId: existing.workspaceId,
		actorId,
		action: 'deleted',
		entityType: 'trigger',
		entityId: id,
		data: existing,
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteTriggerRoute, Env>)

export default app
