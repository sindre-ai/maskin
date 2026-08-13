import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, userStarredObjects } from '@maskin/db/schema'
import { starObjectParamsSchema, starObjectResponseSchema } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// Per-ID star endpoints: derive the workspace from the object row (not a
// header) and gate access with `isWorkspaceMember` — same pattern as every
// other by-ID route in `routes/objects.ts` (see `getObjectRoute`,
// `verifyObjectRoute`). Returning 404 (not 403) on non-member access is
// deliberate — it mirrors the rest of the codebase and avoids leaking
// existence of objects across workspace boundaries.
async function loadObjectForActor(
	db: Database,
	id: string,
	actorId: string,
): Promise<{ workspaceId: string; type: string } | null> {
	const [row] = await db
		.select({ workspaceId: objects.workspaceId, type: objects.type })
		.from(objects)
		.where(eq(objects.id, id))
		.limit(1)
	if (!row) return null
	if (!(await isWorkspaceMember(db, actorId, row.workspaceId))) return null
	return row
}

// POST /{id}/star — star the object for the current actor. Idempotent: a
// second POST when the row already exists is a no-op that still returns
// `{ starred: true }`. Only inserts an audit event on the *transition*
// (not-starred → starred) so the events log stays proportional to real
// user intent, not client retry noise.
const starRoute = createRoute({
	method: 'post',
	path: '/{id}/star',
	tags: ['Objects'],
	summary: 'Star an object for the current actor',
	request: {
		params: starObjectParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: starObjectResponseSchema } },
			description: 'Object is starred for this actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found or not visible to this actor',
		},
	},
})

app.openapi(starRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const object = await loadObjectForActor(db, id, actorId)
	if (!object) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	// onConflictDoNothing().returning() returns [row] on insert, [] on
	// conflict — the presence/absence tells us whether this was a real
	// transition or a duplicate no-op, without a separate read.
	const inserted = await db
		.insert(userStarredObjects)
		.values({ userId: actorId, objectId: id })
		.onConflictDoNothing({
			target: [userStarredObjects.userId, userStarredObjects.objectId],
		})
		.returning({ objectId: userStarredObjects.objectId })

	if (inserted.length > 0) {
		await db.insert(events).values({
			workspaceId: object.workspaceId,
			actorId,
			action: 'starred',
			entityType: object.type,
			entityId: id,
			data: {},
		})
	}

	return c.json({ starred: true }, 200)
})

// DELETE /{id}/star — unstar the object for the current actor. Idempotent:
// unstarring an already-unstarred object returns `{ starred: false }` with
// no error. Audit event is only inserted when a row was actually deleted.
const unstarRoute = createRoute({
	method: 'delete',
	path: '/{id}/star',
	tags: ['Objects'],
	summary: 'Unstar an object for the current actor',
	request: {
		params: starObjectParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: starObjectResponseSchema } },
			description: 'Object is no longer starred for this actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found or not visible to this actor',
		},
	},
})

app.openapi(unstarRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const object = await loadObjectForActor(db, id, actorId)
	if (!object) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	const deleted = await db
		.delete(userStarredObjects)
		.where(and(eq(userStarredObjects.userId, actorId), eq(userStarredObjects.objectId, id)))
		.returning({ objectId: userStarredObjects.objectId })

	if (deleted.length > 0) {
		await db.insert(events).values({
			workspaceId: object.workspaceId,
			actorId,
			action: 'unstarred',
			entityType: object.type,
			entityId: id,
			data: {},
		})
	}

	return c.json({ starred: false }, 200)
})

// GET /{id}/star — read the current star state without mutating. Lets the
// object-card UI (Task 4) hydrate the icon on first render without having
// to POST optimistically. The endpoint stays cheap on the write path —
// the point-lookup hits the composite PK directly.
const getStarRoute = createRoute({
	method: 'get',
	path: '/{id}/star',
	tags: ['Objects'],
	summary: 'Read the current star state for the current actor',
	request: {
		params: starObjectParamsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: starObjectResponseSchema } },
			description: 'Current star state',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found or not visible to this actor',
		},
	},
})

app.openapi(getStarRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const object = await loadObjectForActor(db, id, actorId)
	if (!object) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	const [row] = await db
		.select({ objectId: userStarredObjects.objectId })
		.from(userStarredObjects)
		.where(and(eq(userStarredObjects.userId, actorId), eq(userStarredObjects.objectId, id)))
		.limit(1)

	return c.json({ starred: !!row }, 200)
})

export default app
