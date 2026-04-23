import { randomUUID } from 'node:crypto'
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
import { type AgentStorageManager, workspaceSkillKey } from '../services/agent-storage'

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
	sizeBytes: z.number().int().nonnegative(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

const workspaceSkillDetailSchema = workspaceSkillListItemSchema.extend({
	content: z.string(),
})

const workspaceIdParam = z.object({ workspaceId: z.string().uuid() })
const workspaceIdAndNameParam = z.object({
	workspaceId: z.string().uuid(),
	name: skillNameSchema,
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

	let parsed: ReturnType<typeof parseSkillMd>
	try {
		parsed = parseSkillMd(body.content)
	} catch (err) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				err instanceof Error ? err.message : 'Invalid SKILL.md content',
			),
			400,
		)
	}
	const description = parsed.description ? parsed.description : null

	// DB first, then S3. The unique index on (workspace_id, name) atomically
	// rejects duplicate names, so two concurrent creators race on the DB (one
	// wins with 201, the other gets 409) rather than on a shared S3 object.
	// storageKey is derived from the row's UUID so no two writers ever target
	// the same key.
	const skillId = randomUUID()
	const storageKey = workspaceSkillKey(workspaceId, skillId)
	const sizeBytes = Buffer.byteLength(body.content, 'utf-8')

	let created: typeof workspaceSkills.$inferSelect | undefined
	try {
		const rows = await db
			.insert(workspaceSkills)
			.values({
				id: skillId,
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
		if (err instanceof Error && /workspace_skills_ws_name_uniq/.test(err.message)) {
			return c.json(
				createApiError('CONFLICT', 'A skill with this name already exists in this workspace'),
				409,
			)
		}
		throw err
	}

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace skill'), 500)
	}

	try {
		await storage.putWorkspaceSkill(workspaceId, skillId, body.content)
	} catch (err) {
		// S3 write failed — remove the DB row we just inserted so we don't leave
		// metadata pointing at a missing object. Cascade drops any (unlikely)
		// attachment the caller raced in.
		try {
			await db.delete(workspaceSkills).where(eq(workspaceSkills.id, skillId))
		} catch (rollbackErr) {
			logger.error(
				'Failed to roll back DB insert after S3 write failure — row now points at missing storage key',
				{
					workspaceId,
					skillId,
					storageKey,
					error: String(rollbackErr),
				},
			)
		}
		throw err
	}

	// Audit event — do NOT include the content field (8KB NOTIFY payload cap).
	// The mutation has already succeeded; a failing audit write must not
	// translate into a 500 for the caller.
	try {
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
	} catch (err) {
		logger.error('Failed to record workspace_skill created audit event', {
			workspaceId,
			skillId: created.id,
			error: String(err),
		})
	}

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

	const [existing] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	let parsed: ReturnType<typeof parseSkillMd>
	try {
		parsed = parseSkillMd(body.content)
	} catch (err) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				err instanceof Error ? err.message : 'Invalid SKILL.md content',
			),
			400,
		)
	}
	const description = parsed.description ? parsed.description : null

	// S3 key is keyed on the skill's UUID, so writing here cannot collide with
	// a concurrent create-with-same-name (which would race on a different id)
	// or a delete-then-create cycle (new id = new key).
	const { sizeBytes } = await storage.putWorkspaceSkill(workspaceId, existing.id, body.content)

	const now = new Date()
	let updated: typeof workspaceSkills.$inferSelect | undefined
	try {
		const rows = await db
			.update(workspaceSkills)
			.set({
				content: body.content,
				description,
				sizeBytes,
				updatedAt: now,
			})
			.where(eq(workspaceSkills.id, existing.id))
			.returning()
		updated = rows[0]
	} catch (err) {
		// Roll back the S3 write to the previous content. Since the S3 key is
		// scoped to this skill's UUID, the rollback only ever affects this skill
		// — it cannot overwrite a concurrent successful update on a different
		// skill that happened to share the same name.
		try {
			await storage.putWorkspaceSkill(workspaceId, existing.id, existing.content)
		} catch (rollbackErr) {
			logger.error(
				'Failed to roll back S3 write after DB update failure — storage now holds new content while DB reports old metadata',
				{
					workspaceId,
					skillId: existing.id,
					name,
					error: String(rollbackErr),
				},
			)
		}
		throw err
	}

	if (!updated) {
		// Row vanished between select and update (concurrent delete). The
		// concurrent delete also removed its own S3 object (scoped to the same
		// id), so no rollback is needed here.
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	try {
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
	} catch (err) {
		logger.error('Failed to record workspace_skill updated audit event', {
			workspaceId,
			skillId: updated.id,
			error: String(err),
		})
	}

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

	// DB first — cascades remove agent_skills attachments. Delete S3 second as
	// best-effort; an orphan S3 object keyed on the deleted skill's UUID is
	// inert and cannot be picked up by a future recreate (which will mint a
	// new UUID = new S3 key).
	await db.delete(workspaceSkills).where(eq(workspaceSkills.id, existing.id))

	try {
		await storage.deleteWorkspaceSkill(workspaceId, existing.id)
	} catch (err) {
		logger.error('Failed to delete workspace skill from storage (orphan object left)', {
			workspaceId,
			skillId: existing.id,
			name,
			storageKey: existing.storageKey,
			error: String(err),
		})
	}

	try {
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
	} catch (err) {
		logger.error('Failed to record workspace_skill deleted audit event', {
			workspaceId,
			skillId: existing.id,
			error: String(err),
		})
	}

	return c.json({ deleted: true as const }, 200)
}) as RouteHandler<typeof deleteWorkspaceSkillRoute, Env>)

export default app
