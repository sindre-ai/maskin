import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { userStarredObjects } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const { default: objectsRoutes } = await import('../../routes/objects')

// Per-actor app builder so tests can prove that starred rows are per-user:
// actor A's list must return `isStarred=true` for A's stars only, never B's.
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
	app.route('/api/objects', objectsRoutes)
	return app
}

describe('GET /api/objects — isStarred + starred filter (T9 + T10)', () => {
	let workspaceId: string
	let actorA: string
	let actorB: string

	beforeEach(async () => {
		actorA = getTestActorId()
		const otherActor = await insertActor(db)
		actorB = otherActor.id
		const ws = await insertWorkspace(db, actorA)
		workspaceId = ws.id
		// Add actor B to the same workspace so both actors' list reads are
		// authorised, not just able to seed star rows.
		await sql`
			INSERT INTO workspace_members (workspace_id, actor_id, role)
			VALUES (${workspaceId}, ${actorB}, 'member')
		`
	})

	it('populates isStarred per-viewer — actor A sees only A stars', async () => {
		const starredByA = await insertObject(db, workspaceId, actorA, { title: 'A star' })
		const starredByB = await insertObject(db, workspaceId, actorA, { title: 'B star' })
		const unstarred = await insertObject(db, workspaceId, actorA, { title: 'no stars' })

		await db.insert(userStarredObjects).values([
			{ userId: actorA, objectId: starredByA.id },
			{ userId: actorB, objectId: starredByB.id },
		])

		const asA = await appAs(actorA).request(
			jsonGet('/api/objects', { 'x-workspace-id': workspaceId }),
		)
		expect(asA.status).toBe(200)
		const rowsA: Array<{ id: string; isStarred: boolean }> = await asA.json()
		const byIdA = new Map(rowsA.map((r) => [r.id, r.isStarred]))
		expect(byIdA.get(starredByA.id)).toBe(true)
		expect(byIdA.get(starredByB.id)).toBe(false)
		expect(byIdA.get(unstarred.id)).toBe(false)

		const asB = await appAs(actorB).request(
			jsonGet('/api/objects', { 'x-workspace-id': workspaceId }),
		)
		expect(asB.status).toBe(200)
		const rowsB: Array<{ id: string; isStarred: boolean }> = await asB.json()
		const byIdB = new Map(rowsB.map((r) => [r.id, r.isStarred]))
		expect(byIdB.get(starredByA.id)).toBe(false)
		expect(byIdB.get(starredByB.id)).toBe(true)
		expect(byIdB.get(unstarred.id)).toBe(false)
	})

	it('returns isStarred=false on every row when the workspace has no stars — join must not inflate row count', async () => {
		const objects = await Promise.all([
			insertObject(db, workspaceId, actorA, { title: 'one' }),
			insertObject(db, workspaceId, actorA, { title: 'two' }),
			insertObject(db, workspaceId, actorA, { title: 'three' }),
		])

		const res = await appAs(actorA).request(
			jsonGet('/api/objects', { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const rows: Array<{ id: string; isStarred: boolean }> = await res.json()
		expect(rows.filter((r) => objects.some((o) => o.id === r.id))).toHaveLength(3)
		for (const row of rows) expect(row.isStarred).toBe(false)
	})

	it('?starred=true narrows to only the caller-starred rows (per-user)', async () => {
		const [a1, a2, notMineA, sharedByB] = await Promise.all([
			insertObject(db, workspaceId, actorA, { title: 'a-1' }),
			insertObject(db, workspaceId, actorA, { title: 'a-2' }),
			insertObject(db, workspaceId, actorA, { title: 'a-3' }),
			insertObject(db, workspaceId, actorA, { title: 'b-1' }),
		])

		await db.insert(userStarredObjects).values([
			{ userId: actorA, objectId: a1.id },
			{ userId: actorA, objectId: a2.id },
			{ userId: actorB, objectId: sharedByB.id },
		])

		const asA = await appAs(actorA).request(
			jsonGet('/api/objects?starred=true', { 'x-workspace-id': workspaceId }),
		)
		expect(asA.status).toBe(200)
		const rowsA: Array<{ id: string; isStarred: boolean }> = await asA.json()
		expect(rowsA.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort())
		for (const row of rowsA) expect(row.isStarred).toBe(true)
		expect(rowsA.find((r) => r.id === notMineA.id)).toBeUndefined()
		expect(rowsA.find((r) => r.id === sharedByB.id)).toBeUndefined()

		const asB = await appAs(actorB).request(
			jsonGet('/api/objects?starred=true', { 'x-workspace-id': workspaceId }),
		)
		expect(asB.status).toBe(200)
		const rowsB: Array<{ id: string; isStarred: boolean }> = await asB.json()
		expect(rowsB.map((r) => r.id)).toEqual([sharedByB.id])
	})

	it('?starred=true returns [] when the caller has no stars — empty state must not error', async () => {
		await insertObject(db, workspaceId, actorA, { title: 'unstarred' })

		const res = await appAs(actorA).request(
			jsonGet('/api/objects?starred=true', { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('the starred=true filter plan hits the user_starred_objects composite PK (no seq scan)', async () => {
		// Seed enough rows that the planner would prefer an index if one applies —
		// on an empty table Postgres may pick a seq scan regardless, which would
		// mask the pattern this assertion exists to protect.
		const objs = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				insertObject(db, workspaceId, actorA, { title: `bulk ${i}` }),
			),
		)
		await db
			.insert(userStarredObjects)
			.values(objs.slice(0, 10).map((o) => ({ userId: actorA, objectId: o.id })))

		const rawPlan = await sql.unsafe(`
			EXPLAIN
			SELECT o.id
			FROM objects o
			WHERE o.workspace_id = '${workspaceId}'
			  AND EXISTS (
				SELECT 1 FROM user_starred_objects s
				WHERE s.user_id = '${actorA}' AND s.object_id = o.id
			  )
		`)
		const plan = rawPlan.map((row) => String(Object.values(row)[0])).join('\n')
		// The composite PK on (user_id, object_id) is what the EXISTS resolves
		// against — if the planner ever falls back to a seq scan on
		// user_starred_objects, this test flags it before it slips into prod.
		expect(plan).toMatch(/user_starred_objects/)
		expect(plan).not.toMatch(/Seq Scan on user_starred_objects/)
	})
})
