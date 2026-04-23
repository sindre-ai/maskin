import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { attachSkillSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>()

async function isWorkspaceMember(db: Database, workspaceId: string, actorId: string) {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	return Boolean(row)
}

// -- Response schemas --

const attachedSkillSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	storageKey: z.string(),
	sizeBytes: z.number(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	attachedAt: z.string().nullable(),
})

const actorIdParam = z.object({ actorId: z.string().uuid() })
const actorIdAndSkillIdParam = z.object({
	actorId: z.string().uuid(),
	workspaceSkillId: z.string().uuid(),
})

// -- Routes --

// GET /:actorId/workspace-skills — List workspace skills attached to an actor
const listAttachedSkillsRoute = createRoute({
	method: 'get',
	path: '/{actorId}/workspace-skills',
	tags: ['Agent Skill Attachments'],
	summary: 'List workspace skills attached to an agent',
	request: {
		params: actorIdParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(attachedSkillSchema) } },
			description: 'Attached workspace skills',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller is not a member of any workspace this actor belongs to',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(listAttachedSkillsRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { actorId } = c.req.valid('param')

	const [actor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Caller must share at least one workspace with the target actor.
	const callerWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, callerActorId))

	const callerWorkspaceIds = new Set(callerWorkspaces.map((row) => row.workspaceId))

	const actorWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorId))

	const sharedWorkspaceIds = actorWorkspaces
		.map((row) => row.workspaceId)
		.filter((id) => callerWorkspaceIds.has(id))

	if (sharedWorkspaceIds.length === 0) {
		return c.json(
			createApiError('FORBIDDEN', 'Not a member of any workspace this actor belongs to'),
			403,
		)
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
			attachedAt: agentSkills.createdAt,
		})
		.from(agentSkills)
		.innerJoin(workspaceSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
		.where(eq(agentSkills.actorId, actorId))

	const visible = rows.filter((row) => callerWorkspaceIds.has(row.workspaceId))

	return c.json(serializeArray(visible) as z.infer<typeof attachedSkillSchema>[], 200)
}) as RouteHandler<typeof listAttachedSkillsRoute, Env>)

// POST /:actorId/workspace-skills — Attach a workspace skill to an actor
const attachSkillRoute = createRoute({
	method: 'post',
	path: '/{actorId}/workspace-skills',
	tags: ['Agent Skill Attachments'],
	summary: 'Attach a workspace skill to an agent',
	request: {
		params: actorIdParam,
		body: {
			content: {
				'application/json': {
					schema: attachSkillSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: attachedSkillSchema } },
			description: 'Workspace skill attached (or already attached)',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: "Skill's workspace does not match the actor's workspace membership",
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: "Caller is not a member of the skill's workspace",
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor or workspace skill not found',
		},
	},
})

app.openapi(attachSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { actorId } = c.req.valid('param')
	const { workspaceSkillId } = c.req.valid('json')

	const [actor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [skill] = await db
		.select()
		.from(workspaceSkills)
		.where(eq(workspaceSkills.id, workspaceSkillId))
		.limit(1)
	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	if (!(await isWorkspaceMember(db, skill.workspaceId, callerActorId))) {
		return c.json(createApiError('FORBIDDEN', "Not a member of the skill's workspace"), 403)
	}

	if (!(await isWorkspaceMember(db, skill.workspaceId, actorId))) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				"Cannot attach a skill to an actor outside the skill's workspace",
			),
			400,
		)
	}

	// Idempotent attach — ON CONFLICT DO NOTHING returns no rows when the row
	// already exists, so we fetch after the insert to return the current state.
	const inserted = await db
		.insert(agentSkills)
		.values({ actorId, workspaceSkillId })
		.onConflictDoNothing()
		.returning()

	const attachedAt =
		inserted[0]?.createdAt ??
		(
			await db
				.select({ createdAt: agentSkills.createdAt })
				.from(agentSkills)
				.where(
					and(eq(agentSkills.actorId, actorId), eq(agentSkills.workspaceSkillId, workspaceSkillId)),
				)
				.limit(1)
		)[0]?.createdAt ??
		null

	// Only record an event for the first attach, not for idempotent re-attaches.
	if (inserted.length > 0) {
		await db.insert(events).values({
			workspaceId: skill.workspaceId,
			actorId: callerActorId,
			action: 'attached',
			entityType: 'agent_skill',
			entityId: skill.id,
			data: {
				actorId,
				workspaceSkillId: skill.id,
				skillName: skill.name,
			},
		})
	}

	const response = {
		id: skill.id,
		workspaceId: skill.workspaceId,
		name: skill.name,
		description: skill.description,
		storageKey: skill.storageKey,
		sizeBytes: skill.sizeBytes,
		createdBy: skill.createdBy,
		createdAt: skill.createdAt instanceof Date ? skill.createdAt.toISOString() : skill.createdAt,
		updatedAt: skill.updatedAt instanceof Date ? skill.updatedAt.toISOString() : skill.updatedAt,
		attachedAt: attachedAt instanceof Date ? attachedAt.toISOString() : attachedAt,
	}

	return c.json(response as z.infer<typeof attachedSkillSchema>, 200)
}) as RouteHandler<typeof attachSkillRoute, Env>)

// DELETE /:actorId/workspace-skills/:workspaceSkillId — Detach a skill
const detachSkillRoute = createRoute({
	method: 'delete',
	path: '/{actorId}/workspace-skills/{workspaceSkillId}',
	tags: ['Agent Skill Attachments'],
	summary: 'Detach a workspace skill from an agent',
	request: {
		params: actorIdAndSkillIdParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Skill detached',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: "Caller is not a member of the skill's workspace",
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor, skill, or attachment not found',
		},
	},
})

app.openapi(detachSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { actorId, workspaceSkillId } = c.req.valid('param')

	const [actor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [skill] = await db
		.select()
		.from(workspaceSkills)
		.where(eq(workspaceSkills.id, workspaceSkillId))
		.limit(1)
	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	if (!(await isWorkspaceMember(db, skill.workspaceId, callerActorId))) {
		return c.json(createApiError('FORBIDDEN', "Not a member of the skill's workspace"), 403)
	}

	const deleted = await db
		.delete(agentSkills)
		.where(
			and(eq(agentSkills.actorId, actorId), eq(agentSkills.workspaceSkillId, workspaceSkillId)),
		)
		.returning()

	if (deleted.length === 0) {
		return c.json(createApiError('NOT_FOUND', 'Skill attachment not found'), 404)
	}

	await db.insert(events).values({
		workspaceId: skill.workspaceId,
		actorId: callerActorId,
		action: 'detached',
		entityType: 'agent_skill',
		entityId: skill.id,
		data: {
			actorId,
			workspaceSkillId: skill.id,
			skillName: skill.name,
		},
	})

	return c.json({ deleted: true as const }, 200)
}) as RouteHandler<typeof detachSkillRoute, Env>)

export default app
