import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, objects, userStarredObjects, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const { default: starObjectsRoutes } = await import('../../routes/star-objects')

// Same per-actor app builder pattern as objects-verification.test.ts —
// integration tests here need to swap the caller identity per case
// (owner vs non-member) to exercise the workspace-membership guard.
function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/objects', starObjectsRoutes)
	return app
}

describe('Star objects integration', () => {
	let workspaceId: string
	let ownerId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	it('POST is idempotent under the composite PK — no duplicate rows, no duplicate events', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const app = appAs(ownerId)

		const first = await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ starred: true })

		const second = await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)
		expect(second.status).toBe(200)
		expect(await second.json()).toEqual({ starred: true })

		// The composite PK on (user_id, object_id) plus onConflictDoNothing
		// must leave exactly one row after two POSTs. If the ON CONFLICT
		// target were mis-specified, this would either error or insert a
		// second row — this is the DB semantic that mocked tests cannot
		// catch (see .claude/rules/verification.md).
		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(and(eq(userStarredObjects.userId, ownerId), eq(userStarredObjects.objectId, obj.id)))
		expect(stars).toHaveLength(1)

		// Idempotent audit: exactly one `starred` event, not two — the second
		// POST must skip the event insert when nothing changed.
		const starEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, obj.id), eq(events.action, 'starred')))
		expect(starEvents).toHaveLength(1)
	})

	it('DELETE is idempotent — unstarring twice returns 200 with no events after the first', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const app = appAs(ownerId)

		// Star it once so the first DELETE has something to remove
		await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)

		const first = await app.request(jsonDelete(`/api/objects/${obj.id}/star`))
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ starred: false })

		const second = await app.request(jsonDelete(`/api/objects/${obj.id}/star`))
		expect(second.status).toBe(200)
		expect(await second.json()).toEqual({ starred: false })

		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(eq(userStarredObjects.objectId, obj.id))
		expect(stars).toHaveLength(0)

		const unstarEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, obj.id), eq(events.action, 'unstarred')))
		expect(unstarEvents).toHaveLength(1)
	})

	it('GET reflects the current state', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const app = appAs(ownerId)

		const before = await app.request(jsonGet(`/api/objects/${obj.id}/star`))
		expect(before.status).toBe(200)
		expect(await before.json()).toEqual({ starred: false })

		await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)

		const after = await app.request(jsonGet(`/api/objects/${obj.id}/star`))
		expect(after.status).toBe(200)
		expect(await after.json()).toEqual({ starred: true })
	})

	it('stars are per-user — two actors can independently star the same object', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		// A second workspace member starring the same object must succeed
		// and not collide with the first — the PK is (user_id, object_id).
		const other = await insertActor(db)
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: other.id,
			role: 'member',
		})

		await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)
		await appAs(other.id).request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)

		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(eq(userStarredObjects.objectId, obj.id))
		expect(stars).toHaveLength(2)
	})

	it('cascades: deleting the object removes the star row', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const app = appAs(ownerId)
		await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)

		await db.delete(objects).where(eq(objects.id, obj.id))

		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(eq(userStarredObjects.objectId, obj.id))
		expect(stars).toHaveLength(0)
	})

	it('cascades: deleting the actor removes their stars', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const other = await insertActor(db)
		// Insert the star row directly to isolate the actor→star cascade —
		// going through the endpoint would also write an `events` row that
		// pins the actor via the events.actor_id FK and defeats the delete.
		await db.insert(userStarredObjects).values({ userId: other.id, objectId: obj.id })

		await db.delete(actors).where(eq(actors.id, other.id))

		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(eq(userStarredObjects.userId, other.id))
		expect(stars).toHaveLength(0)
	})

	it('returns 404 when a non-member tries to star an object in another workspace', async () => {
		const obj = await insertObject(db, workspaceId, ownerId)
		const outsider = await insertActor(db)

		const res = await appAs(outsider.id).request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
				'content-type': 'application/json',
			}),
		)
		expect(res.status).toBe(404)

		// No star row was written despite the outsider getting through auth
		const stars = await db
			.select()
			.from(userStarredObjects)
			.where(eq(userStarredObjects.objectId, obj.id))
		expect(stars).toHaveLength(0)
	})

	it('meets the <500ms p95 latency target for the star toggle', async () => {
		const N = 30
		const objs = await Promise.all(
			Array.from({ length: N }, () => insertObject(db, workspaceId, ownerId)),
		)
		const app = appAs(ownerId)

		const timings: number[] = []
		for (const obj of objs) {
			const start = performance.now()
			const res = await app.request(
				jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, {
					'content-type': 'application/json',
				}),
			)
			timings.push(performance.now() - start)
			expect(res.status).toBe(200)
		}

		timings.sort((a, b) => a - b)
		const p95 = timings[Math.floor(N * 0.95) - 1]
		console.log(
			`[star-toggle bench] N=${N}  p50=${timings[Math.floor(N / 2)].toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${timings[N - 1].toFixed(1)}ms`,
		)
		// The bet contract is <500ms end-to-end (round-trip). This
		// benchmark runs in-process against a local Postgres, so the
		// measurement excludes network — that's fine, it's a floor:
		// if this fails, real-world latency has no chance.
		expect(p95).toBeLessThan(500)
	})
})
