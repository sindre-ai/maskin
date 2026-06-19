import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, reactions } from '@maskin/db/schema'
import {
	reactionsByObjectQuerySchema,
	reactionsByObjectResponseSchema,
	toggleReactionBodySchema,
} from '@maskin/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// Resolves the parent object for a comment-style event, scoped to the caller's
// workspace. The parent object is what the events fan-out is keyed on (so SSE
// invalidation lights up the right detail/graph queries) and it's the
// authorisation root — if the event's parent isn't in the caller's workspace
// we refuse to touch it. Returns null on lookup miss so the route can 404.
async function resolveEventParentObject(
	db: Database,
	workspaceId: string,
	eventId: number,
): Promise<{ objectId: string } | null> {
	const [row] = await db
		.select({
			workspaceId: events.workspaceId,
			entityType: events.entityType,
			entityId: events.entityId,
		})
		.from(events)
		.where(eq(events.id, eventId))
		.limit(1)

	if (!row) return null
	if (row.workspaceId !== workspaceId) return null
	// v1 only supports reacting to events scoped to an object — comments are
	// what humans see in the activity feed and that's what the design covers.
	// Refusing here also prevents reacting to internal lifecycle events
	// (status_changed, created) which would surface confusingly in the UI.
	if (row.entityType !== 'object') return null

	return { objectId: row.entityId }
}

// POST /api/reactions — add a reaction (idempotent).
const addReactionRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Reactions'],
	summary: 'Add a reaction to an event',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: toggleReactionBodySchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Reaction added (or already present)',
			content: { 'application/json': { schema: z.object({ added: z.literal(true) }) } },
		},
		404: {
			description: 'Target event not found in workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(addReactionRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const parent = await resolveEventParentObject(db, workspaceId, body.event_id)
	if (!parent) return c.json(createApiError('NOT_FOUND', 'Event not found'), 404)

	await db.transaction(async (tx) => {
		// Idempotent: a second click on the same emoji from the same actor is a
		// no-op at the database level. We still emit the SSE-driving event row
		// so any optimistic UI that toggled off can re-sync from server truth.
		await tx
			.insert(reactions)
			.values({
				workspaceId,
				eventId: body.event_id,
				actorId,
				emoji: body.emoji,
			})
			.onConflictDoNothing({
				target: [reactions.eventId, reactions.actorId, reactions.emoji],
			})

		// Realtime fan-out. The events row carries the parent object id as
		// entity_id (matches the existing SSE convention for the object's
		// activity feed) and the reaction details on `data` for clients that
		// want to invalidate just the affected event. The PG NOTIFY payload
		// only carries the metadata, not `data`, so this is 8KB-safe.
		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'reacted',
			entityType: 'object',
			entityId: parent.objectId,
			data: {
				eventId: body.event_id,
				emoji: body.emoji,
			},
		})
	})

	return c.json({ added: true as const }, 201)
}) as RouteHandler<typeof addReactionRoute, Env>)

// DELETE /api/reactions — remove a reaction (idempotent).
const removeReactionRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['Reactions'],
	summary: 'Remove a reaction from an event',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: toggleReactionBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Reaction removed (or already absent)',
			content: { 'application/json': { schema: z.object({ removed: z.literal(true) }) } },
		},
		404: {
			description: 'Target event not found in workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(removeReactionRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const parent = await resolveEventParentObject(db, workspaceId, body.event_id)
	if (!parent) return c.json(createApiError('NOT_FOUND', 'Event not found'), 404)

	await db.transaction(async (tx) => {
		await tx
			.delete(reactions)
			.where(
				and(
					eq(reactions.eventId, body.event_id),
					eq(reactions.actorId, actorId),
					eq(reactions.emoji, body.emoji),
				),
			)

		// Always emit the SSE row, even on a no-op delete — same reasoning as
		// the add path. Clients with optimistic UI re-sync from server truth.
		await tx.insert(events).values({
			workspaceId,
			actorId,
			action: 'unreacted',
			entityType: 'object',
			entityId: parent.objectId,
			data: {
				eventId: body.event_id,
				emoji: body.emoji,
			},
		})
	})

	return c.json({ removed: true as const }, 200)
}) as RouteHandler<typeof removeReactionRoute, Env>)

// GET /api/reactions?object_id=… — bulk fetch reactions on every commented
// event under one object, returned as a map keyed by event_id so the client
// renders chip-rows in O(1) per comment.
const listReactionsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Reactions'],
	summary: 'List reactions for every event under an object',
	request: {
		headers: workspaceIdHeader,
		query: reactionsByObjectQuerySchema,
	},
	responses: {
		200: {
			description: 'Reactions grouped by event id',
			content: { 'application/json': { schema: reactionsByObjectResponseSchema } },
		},
		404: {
			description: 'Object not found in workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listReactionsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { object_id: objectId } = c.req.valid('query')

	// Verify the object belongs to the caller's workspace before exposing its
	// reaction list — same defence-in-depth as the subscriptions route, because
	// reactions carry actor ids that an attacker could otherwise probe by
	// guessing object ids from other workspaces.
	const [object] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!object) return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)

	// Find every event id scoped to this object and its workspace; reactions
	// can only live on events that pass this check, so the second query inherits
	// the workspace boundary without re-applying it.
	const objectEvents = await db
		.select({ id: events.id })
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityId, objectId)))

	if (objectEvents.length === 0) {
		return c.json({ reactionsByEventId: {} })
	}

	const rows = await db
		.select()
		.from(reactions)
		.where(
			and(
				eq(reactions.workspaceId, workspaceId),
				inArray(
					reactions.eventId,
					objectEvents.map((e) => e.id),
				),
			),
		)
		.orderBy(asc(reactions.createdAt))

	const reactionsByEventId: Record<
		string,
		Array<z.infer<typeof reactionsByObjectResponseSchema>['reactionsByEventId'][string][number]>
	> = {}
	for (const row of rows) {
		const key = String(row.eventId)
		const list = reactionsByEventId[key] ?? []
		list.push({
			id: row.id,
			eventId: row.eventId,
			actorId: row.actorId,
			emoji: row.emoji,
			createdAt:
				row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
		})
		reactionsByEventId[key] = list
	}

	return c.json({ reactionsByEventId })
}) as RouteHandler<typeof listReactionsRoute, Env>)

export default app
