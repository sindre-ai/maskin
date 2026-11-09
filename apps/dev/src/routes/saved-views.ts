import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	objects,
	savedViews,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	type SavedViewKind,
	createSavedViewSchema,
	normalizeTags,
	savedViewApplyResponseSchema,
	savedViewListQuerySchema,
	savedViewResponseSchema,
} from '@maskin/shared'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { type ViewRow, applySavedView } from '../lib/saved-view-apply'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** A workspace keeps at most this many views, so the list stays short enough to read. */
const MAX_VIEWS_PER_WORKSPACE = 100

function serializeView(
	row: typeof savedViews.$inferSelect,
): z.infer<typeof savedViewResponseSchema> {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		kind: row.kind as SavedViewKind,
		filter: row.filter as z.infer<typeof savedViewResponseSchema>['filter'],
		groupBy: row.groupBy as 'tag' | 'driver' | null,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}
}

// GET / - List the workspace's saved views
const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Saved Views'],
	summary: 'List the workspace’s saved views',
	request: { headers: workspaceIdHeader, query: savedViewListQuerySchema },
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ views: z.array(savedViewResponseSchema) }) },
			},
			description: 'Saved views, by name',
		},
	},
})

app.openapi(listRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { kind } = c.req.valid('query')

	const rows = await db
		.select()
		.from(savedViews)
		.where(
			and(eq(savedViews.workspaceId, workspaceId), kind ? eq(savedViews.kind, kind) : undefined),
		)
		.orderBy(asc(sql`lower(${savedViews.name})`), asc(savedViews.id))

	return c.json({ views: rows.map(serializeView) })
}) as RouteHandler<typeof listRoute, Env>)

// POST / - Create a saved view
const createViewRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Saved Views'],
	summary: 'Create a saved view for flows, agents or chats',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createSavedViewSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: savedViewResponseSchema } },
			description: 'Saved view created',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A view of this kind already has this name, or the workspace is full',
		},
	},
})

app.openapi(createViewRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [{ total } = { total: 0 }] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(savedViews)
		.where(eq(savedViews.workspaceId, workspaceId))
	if (total >= MAX_VIEWS_PER_WORKSPACE) {
		return c.json(
			createApiError(
				'CONFLICT',
				`A workspace keeps at most ${MAX_VIEWS_PER_WORKSPACE} saved views`,
			),
			409,
		)
	}

	const filter = {
		...(body.filter.tags !== undefined && { tags: normalizeTags(body.filter.tags) }),
		...(body.filter.driverId !== undefined && { driverId: body.filter.driverId }),
	}
	// The unique index on (workspace, kind, lower(name)) is the single judge of a duplicate name,
	// so two requests at once can not both win.
	const [created] = await db
		.insert(savedViews)
		.values({
			workspaceId,
			kind: body.kind,
			name: body.name,
			filter,
			groupBy: body.groupBy,
			createdBy: actorId,
		})
		.onConflictDoNothing()
		.returning()
	if (!created) {
		return c.json(
			createApiError('CONFLICT', 'A saved view of this kind already has this name'),
			409,
		)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'saved_view_created',
		entityType: 'saved_view',
		entityId: created.id,
		data: { kind: created.kind, name: created.name },
	})

	return c.json(serializeView(created), 201)
}) as RouteHandler<typeof createViewRoute, Env>)

// GET /:id/apply - The ids a saved view matches, in groups
const applyRoute = createRoute({
	method: 'get',
	path: '/{id}/apply',
	tags: ['Saved Views'],
	summary: 'Apply a saved view: the matching ids, split into its groups',
	description:
		'Flows are every flow in the workspace and agents are every agent in it. Chats are only the caller’s own chats that are not archived, so a view never shows a chat the caller is not in.',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: savedViewApplyResponseSchema } },
			description: 'The view and its groups',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

async function loadRowsForKind(
	db: Database,
	kind: SavedViewKind,
	workspaceId: string,
	callerId: string,
): Promise<ViewRow[]> {
	if (kind === 'flow') {
		const rows = await db
			.select({ id: objects.id, driver: objects.driver, metadata: objects.metadata })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
			.orderBy(asc(sql`lower(${objects.title})`), asc(objects.id))
		return rows.map((r) => ({
			id: r.id,
			driverId: r.driver,
			tags: normalizeTags((r.metadata as Record<string, unknown> | null)?.tags),
		}))
	}
	if (kind === 'agent') {
		const rows = await db
			.select({ id: actors.id, metadata: actors.metadata })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))
			.orderBy(asc(sql`lower(${actors.name})`), asc(actors.id))
		return rows.map((r) => ({
			id: r.id,
			driverId: null,
			tags: normalizeTags((r.metadata as Record<string, unknown> | null)?.tags),
		}))
	}
	const rows = await db
		.select({ id: conversations.id, tags: conversations.tags })
		.from(conversations)
		.innerJoin(
			conversationParticipants,
			eq(conversationParticipants.conversationId, conversations.id),
		)
		.where(
			and(
				eq(conversations.workspaceId, workspaceId),
				eq(conversationParticipants.actorId, callerId),
				isNull(conversationParticipants.leftAt),
				eq(conversationParticipants.archived, false),
			),
		)
		.orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
	return rows.map((r) => ({ id: r.id, driverId: null, tags: normalizeTags(r.tags) }))
}

app.openapi(applyRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const [view] = await db
		.select()
		.from(savedViews)
		.where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
		.limit(1)
	if (!view) return c.json(createApiError('NOT_FOUND', 'Saved view not found'), 404)

	const serialized = serializeView(view)
	const rows = await loadRowsForKind(db, serialized.kind, workspaceId, callerId)
	return c.json({
		view: serialized,
		groups: applySavedView(rows, { filter: serialized.filter, groupBy: serialized.groupBy }),
	})
}) as RouteHandler<typeof applyRoute, Env>)

// DELETE /:id - Delete a saved view
const deleteRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Saved Views'],
	summary: 'Delete a saved view',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } },
			description: 'Saved view deleted',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(deleteRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const [deleted] = await db
		.delete(savedViews)
		.where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
		.returning()
	if (!deleted) return c.json(createApiError('NOT_FOUND', 'Saved view not found'), 404)

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'saved_view_deleted',
		entityType: 'saved_view',
		entityId: id,
		data: { kind: deleted.kind, name: deleted.name },
	})

	return c.json({ deleted: true as const })
}) as RouteHandler<typeof deleteRoute, Env>)

export default app
