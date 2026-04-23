import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import {
	type SaveSkillInput,
	parseSkillMd,
	saveSkillSchema,
	serializeSkillMd,
	skillNameSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import type { AgentStorageManager } from '../services/agent-storage'

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

// Verify caller is a member of the workspace
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

const skillListItemSchema = z.object({
	name: z.string(),
	description: z.string(),
	size_bytes: z.number().nullable(),
	updated_at: z.string().nullable(),
})

const skillDetailSchema = z.object({
	name: z.string(),
	description: z.string(),
	content: z.string(),
	frontmatter: z.record(z.string(), z.unknown()),
	size_bytes: z.number().nullable(),
	updated_at: z.string().nullable(),
})

// -- Routes --

// GET /:workspaceId/skills — List team skills shared at the workspace level
const listSkillsRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills',
	tags: ['Workspace Skills'],
	summary: 'List team skills for a workspace',
	request: {
		params: z.object({ workspaceId: z.string().uuid() }),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(skillListItemSchema) } },
			description: 'Team skill list',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
	},
})

app.openapi(listSkillsRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId } = c.req.valid('param')
	const storage = c.get('agentStorage')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const records = await storage.listWorkspaceFileRecords(workspaceId, 'skills')

	const skills = await Promise.all(
		records.map(async (record) => {
			try {
				const content = await storage.getWorkspaceFile(
					workspaceId,
					'skills',
					record.path.replace('skills/', ''),
				)
				const parsed = parseSkillMd(content.toString('utf-8'))
				return {
					name: parsed.name || record.path.replace('skills/', '').replace('/SKILL.md', ''),
					description: parsed.description,
					size_bytes: record.sizeBytes,
					updated_at: record.updatedAt?.toISOString() ?? null,
				}
			} catch {
				return {
					name: record.path.replace('skills/', '').replace('/SKILL.md', ''),
					description: '',
					size_bytes: record.sizeBytes,
					updated_at: record.updatedAt?.toISOString() ?? null,
				}
			}
		}),
	)

	return c.json(skills)
}) as RouteHandler<typeof listSkillsRoute, Env>)

// GET /:workspaceId/skills/:skillName — Get a single team skill
const getSkillRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills/{skillName}',
	tags: ['Workspace Skills'],
	summary: 'Get team skill details',
	request: {
		params: z.object({
			workspaceId: z.string().uuid(),
			skillName: z.string(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: skillDetailSchema } },
			description: 'Skill details',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Skill not found',
		},
	},
})

app.openapi(getSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId, skillName } = c.req.valid('param')
	const storage = c.get('agentStorage')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	try {
		const content = await storage.getWorkspaceFile(workspaceId, 'skills', `${skillName}/SKILL.md`)
		const parsed = parseSkillMd(content.toString('utf-8'))

		return c.json(
			{
				name: parsed.name || skillName,
				description: parsed.description,
				content: parsed.content,
				frontmatter: parsed.frontmatter as Record<string, unknown>,
				size_bytes: content.length,
				updated_at: null as string | null,
			},
			200,
		)
	} catch {
		return c.json(createApiError('NOT_FOUND', 'Skill not found'), 404)
	}
}) as RouteHandler<typeof getSkillRoute, Env>)

// PUT /:workspaceId/skills/:skillName — Create or update a team skill
const saveSkillRoute = createRoute({
	method: 'put',
	path: '/{workspaceId}/skills/{skillName}',
	tags: ['Workspace Skills'],
	summary: 'Create or update a team skill',
	request: {
		params: z.object({
			workspaceId: z.string().uuid(),
			skillName: z.string(),
		}),
		body: {
			content: {
				'application/json': {
					schema: saveSkillSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: skillDetailSchema } },
			description: 'Skill saved',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
	},
})

app.openapi(saveSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId, skillName } = c.req.valid('param')
	const storage = c.get('agentStorage')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const nameResult = skillNameSchema.safeParse(skillName)
	if (!nameResult.success) {
		return c.json(
			createApiError('VALIDATION_ERROR', 'Invalid skill name', [
				{
					field: 'skillName',
					message: 'Use lowercase letters, numbers, and hyphens only',
					expected: 'pattern: /^[a-z0-9][a-z0-9-]*$/',
				},
			]),
			400,
		)
	}

	const body: SaveSkillInput = c.req.valid('json')

	const raw = serializeSkillMd({
		name: skillName,
		description: body.description,
		frontmatter: body.frontmatter,
		content: body.content,
	})

	const buffer = Buffer.from(raw, 'utf-8')
	await storage.uploadWorkspaceFile(workspaceId, 'skills', `${skillName}/SKILL.md`, buffer)

	return c.json(
		{
			name: skillName,
			description: body.description,
			content: body.content,
			frontmatter: (body.frontmatter ?? {}) as Record<string, unknown>,
			size_bytes: buffer.length,
			updated_at: new Date().toISOString() as string | null,
		},
		200,
	)
}) as RouteHandler<typeof saveSkillRoute, Env>)

// DELETE /:workspaceId/skills/:skillName — Delete a team skill
const deleteSkillRoute = createRoute({
	method: 'delete',
	path: '/{workspaceId}/skills/{skillName}',
	tags: ['Workspace Skills'],
	summary: 'Delete a team skill',
	request: {
		params: z.object({
			workspaceId: z.string().uuid(),
			skillName: z.string(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
			description: 'Skill deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
	},
})

app.openapi(deleteSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId, skillName } = c.req.valid('param')
	const storage = c.get('agentStorage')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	await storage.deleteWorkspaceFile(workspaceId, 'skills', `${skillName}/SKILL.md`)

	return c.json({ ok: true }, 200)
}) as RouteHandler<typeof deleteSkillRoute, Env>)

export default app
