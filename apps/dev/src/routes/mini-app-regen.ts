import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, triggers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema, triggerResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	MASKIN_APP_DATA_WINDOW_KEY,
	MASKIN_STATE_SLOT_ID,
	buildDailyRegenTrigger,
} from '../services/mini-app-regen'
import type { MiniAppFileRef } from '../services/mini-app-regen'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const isHtmlMime = (mime: string): boolean =>
	mime === 'text/html' || mime === 'application/xhtml+xml'

const app = new OpenAPIHono<Env>()

const regenBodySchema = z.object({
	file_id: z.string().uuid(),
	app_name: z.string().min(1).max(255).optional(),
	target_actor_id: z.string().uuid().optional(),
})

const regenResponseSchema = z.object({
	trigger: triggerResponseSchema,
	file: z.object({
		id: z.string().uuid(),
		name: z.string(),
		mime_type: z.string(),
		size_bytes: z.number().int().nonnegative(),
	}),
	slot: z.object({
		id: z.string(),
		window_key: z.string(),
	}),
	cron: z.string(),
})

// POST /regen — provision the daily regen trigger for a hosted app file.
const regenRoute = createRoute({
	method: 'post',
	path: '/regen',
	tags: ['Mini-apps'],
	summary: 'Point/keep an html app current with a daily regen trigger',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: regenBodySchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: regenResponseSchema } },
			description: 'Regen trigger provisioned (created or updated in place)',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a member' },
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(regenRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [file] = await db.select().from(files).where(eq(files.id, body.file_id)).limit(1)
	if (!file || file.workspaceId !== workspaceId) {
		return c.json(createApiError('NOT_FOUND', 'File not found in this workspace'), 404)
	}
	if (!isHtmlMime(file.mimeType)) {
		return c.json(createApiError('VALIDATION_ERROR', 'Regen only applies to hosted html apps'), 400)
	}

	const fileRef: MiniAppFileRef = { id: file.id, name: file.name }
	const appName = body.app_name ?? file.name
	const targetActorId = body.target_actor_id ?? actorId
	const triggerBody = buildDailyRegenTrigger({
		file: fileRef,
		appName,
		targetActorId,
	})

	const name = triggerBody.name

	const [existing] = await db
		.select()
		.from(triggers)
		.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, name)))
		.limit(1)

	const now = new Date()

	if (existing) {
		const [trigger] = await db
			.update(triggers)
			.set({
				config: triggerBody.config,
				actionPrompt: triggerBody.action_prompt,
				targetActorId: triggerBody.target_actor_id,
				enabled: true,
				updatedAt: now,
			})
			.where(eq(triggers.id, existing.id))
			.returning()
		if (!trigger) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to update regen trigger'), 500)
		}
		await db
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'trigger',
				entityId: trigger.id,
				data: { trigger_name: trigger.name, type: 'cron', file_id: file.id },
			})
			.catch(() => undefined)
		return c.json(
			{
				trigger: serialize(trigger) as z.infer<typeof triggerResponseSchema>,
				file: {
					id: file.id,
					name: file.name,
					mime_type: file.mimeType,
					size_bytes: file.sizeBytes,
				},
				slot: { id: MASKIN_STATE_SLOT_ID, window_key: MASKIN_APP_DATA_WINDOW_KEY },
				cron: triggerBody.config.expression,
			} satisfies z.infer<typeof regenResponseSchema>,
			200,
		)
	}

	const [trigger] = await db
		.insert(triggers)
		.values({
			workspaceId,
			name,
			type: 'cron',
			config: triggerBody.config,
			actionPrompt: triggerBody.action_prompt,
			targetActorId: triggerBody.target_actor_id,
			enabled: true,
			createdBy: actorId,
		})
		.returning()
	if (!trigger) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create regen trigger'), 500)
	}
	await db
		.insert(events)
		.values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'trigger',
			entityId: trigger.id,
			data: { trigger_name: trigger.name, type: 'cron', file_id: file.id },
		})
		.catch(() => undefined)

	return c.json(
		{
			trigger: serialize(trigger) as z.infer<typeof triggerResponseSchema>,
			file: {
				id: file.id,
				name: file.name,
				mime_type: file.mimeType,
				size_bytes: file.sizeBytes,
			},
			slot: { id: MASKIN_STATE_SLOT_ID, window_key: MASKIN_APP_DATA_WINDOW_KEY },
			cron: triggerBody.config.expression,
		} satisfies z.infer<typeof regenResponseSchema>,
		200,
	)
}) as RouteHandler<typeof regenRoute, Env>)

export default app
