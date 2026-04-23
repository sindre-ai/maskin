import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	createWorkspaceSkillSchema,
	parseSkillMd,
	skillNameSchema,
	updateWorkspaceSkillSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { AgentStorageManager } from '../services/agent-storage'

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

async function requireWorkspaceMember(db: Database, workspaceId: string, actorId: string) {
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	return member ?? null
}

// -- Response schemas --

const workspaceSkillListItemSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	storageKey: z.string(),
	sizeBytes: z.number(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

const workspaceSkillDetailSchema = workspaceSkillListItemSchema.extend({
	content: z.string(),
})

const workspaceIdParam = z.object({ workspaceId: z.string().uuid() })
const workspaceIdAndNameParam = z.object({
	workspaceId: z.string().uuid(),
	name: z.string(),
})

// -- Routes --

// GET /:workspaceId/skills — List workspace skills (without content)
const listWorkspaceSkillsRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills',
	tags: ['Workspace Skills'],
	summary: 'List workspace skills',
	request: {
		params: workspaceIdParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(workspaceSkillListItemSchema) } },
			description: 'Workspace skills list',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
	},
})

app.openapi(listWorkspaceSkillsRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const rows = await db
		.select({
			id: workspaceSkills.id,
			workspaceId: workspaceSkills.workspaceId,
			name: workspaceSkills.name,
			description: workspaceSkills.description,
			storageKey: workspaceSkills.storageKey,
			sizeBytes: workspaceSkills.sizeBytes,
			createdBy: workspaceSkills.createdBy,
			createdAt: workspaceSkills.createdAt,
			updatedAt: workspaceSkills.updatedAt,
		})
		.from(workspaceSkills)
		.where(eq(workspaceSkills.workspaceId, workspaceId))

	return c.json(serializeArray(rows) as z.infer<typeof workspaceSkillListItemSchema>[], 200)
}) as RouteHandler<typeof listWorkspaceSkillsRoute, Env>)

// GET /:workspaceId/skills/:name — Get a skill with full content
const getWorkspaceSkillRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Get a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill details',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
	},
})

app.openapi(getWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId, name } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [skill] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	return c.json(serialize(skill) as z.infer<typeof workspaceSkillDetailSchema>, 200)
}) as RouteHandler<typeof getWorkspaceSkillRoute, Env>)

// POST /:workspaceId/skills — Create a new workspace skill
const createWorkspaceSkillRoute = createRoute({
	method: 'post',
	path: '/{workspaceId}/skills',
	tags: ['Workspace Skills'],
	summary: 'Create a workspace skill',
	request: {
		params: workspaceIdParam,
		body: {
			content: {
				'application/json': {
					schema: createWorkspaceSkillSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A skill with this name already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId } = c.req.valid('param')
	const body = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const parsed = parseSkillMd(body.content)
	const description = parsed.description ? parsed.description : null

	// Fail fast on name conflict so we don't needlessly write to S3
	const [existing] = await db
		.select({ id: workspaceSkills.id })
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, body.name)))
		.limit(1)

	if (existing) {
		return c.json(
			createApiError('BAD_REQUEST', 'A skill with this name already exists in this workspace'),
			409,
		)
	}

	// Write S3 first, then insert DB. Roll back S3 on DB failure.
	const { storageKey, sizeBytes } = await storage.putWorkspaceSkill(
		workspaceId,
		body.name,
		body.content,
	)

	let created: typeof workspaceSkills.$inferSelect | undefined
	try {
		const rows = await db
			.insert(workspaceSkills)
			.values({
				workspaceId,
				name: body.name,
				description,
				content: body.content,
				storageKey,
				sizeBytes,
				createdBy: callerActorId,
			})
			.returning()
		created = rows[0]
	} catch (err) {
		// Roll back the S3 write so the store doesn't hold an orphan object
		try {
			await storage.deleteWorkspaceSkill(workspaceId, body.name)
		} catch (rollbackErr) {
			logger.warn('Failed to roll back S3 write after DB failure', {
				workspaceId,
				name: body.name,
				error: String(rollbackErr),
			})
		}
		// If the insert failed due to the unique index, surface that as 409
		if (err instanceof Error && /workspace_skills_ws_name_uniq/.test(err.message)) {
			return c.json(
				createApiError('BAD_REQUEST', 'A skill with this name already exists in this workspace'),
				409,
			)
		}
		throw err
	}

	if (!created) {
		try {
			await storage.deleteWorkspaceSkill(workspaceId, body.name)
		} catch {
			// best effort
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace skill'), 500)
	}

	// Audit event — do NOT include the content field (8KB NOTIFY payload cap)
	await db.insert(events).values({
		workspaceId,
		actorId: callerActorId,
		action: 'created',
		entityType: 'workspace_skill',
		entityId: created.id,
		data: {
			id: created.id,
			name: created.name,
			description: created.description,
			sizeBytes: created.sizeBytes,
		},
	})

	return c.json(serialize(created) as z.infer<typeof workspaceSkillDetailSchema>, 201)
}) as RouteHandler<typeof createWorkspaceSkillRoute, Env>)

// PUT /:workspaceId/skills/:name — Update a workspace skill's content
const updateWorkspaceSkillRoute = createRoute({
	method: 'put',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Update a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceSkillSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
	},
})

app.openapi(updateWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, name } = c.req.valid('param')
	const body = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const nameResult = skillNameSchema.safeParse(name)
	if (!nameResult.success) {
		return c.json(
			createApiError('VALIDATION_ERROR', 'Invalid skill name', [
				{
					field: 'name',
					message: 'Use lowercase letters, numbers, and hyphens only',
					expected: 'pattern: /^[a-z0-9-]+$/',
				},
			]),
			400,
		)
	}

	const [existing] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	const parsed = parseSkillMd(body.content)
	const description = parsed.description ? parsed.description : null

	const { sizeBytes } = await storage.putWorkspaceSkill(workspaceId, name, body.content)

	const now = new Date()
	const [updated] = await db
		.update(workspaceSkills)
		.set({
			content: body.content,
			description,
			sizeBytes,
			updatedAt: now,
		})
		.where(eq(workspaceSkills.id, existing.id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	await db.insert(events).values({
		workspaceId,
		actorId: callerActorId,
		action: 'updated',
		entityType: 'workspace_skill',
		entityId: updated.id,
		data: {
			id: updated.id,
			name: updated.name,
			description: updated.description,
			sizeBytes: updated.sizeBytes,
		},
	})

	return c.json(serialize(updated) as z.infer<typeof workspaceSkillDetailSchema>, 200)
}) as RouteHandler<typeof updateWorkspaceSkillRoute, Env>)

// DELETE /:workspaceId/skills/:name — Delete a workspace skill
const deleteWorkspaceSkillRoute = createRoute({
	method: 'delete',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Delete a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Workspace skill deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
	},
})

app.openapi(deleteWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, name } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [existing] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	await storage.deleteWorkspaceSkill(workspaceId, name)
	await db.delete(workspaceSkills).where(eq(workspaceSkills.id, existing.id))

	await db.insert(events).values({
		workspaceId,
		actorId: callerActorId,
		action: 'deleted',
		entityType: 'workspace_skill',
		entityId: existing.id,
		data: {
			id: existing.id,
			name: existing.name,
			description: existing.description,
			sizeBytes: existing.sizeBytes,
		},
	})

	return c.json({ deleted: true as const }, 200)
}) as RouteHandler<typeof deleteWorkspaceSkillRoute, Env>)

export default app
