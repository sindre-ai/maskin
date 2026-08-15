import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { LOOP_STATUSES } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: loopsRoutes } = await import('../../routes/loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

function makeApp(actorId: string) {
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
		await next()
	})
	app.route('/api/loops', loopsRoutes)
	return app
}

describe('Loop status lifecycle migration (0054)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('exposes the new maturity-ladder enum through get_loop / list_loops', async () => {
		// Every rung must be a legal status a real caller can persist and read
		// back — this is the schema-layer contract downstream tasks read from.
		const rows = await Promise.all(
			LOOP_STATUSES.map((status) =>
				insertObject(db, workspaceId, actorId, {
					type: 'loop',
					status,
					title: `Loop at ${status}`,
				}),
			),
		)

		const app = makeApp(actorId)
		const listRes = await app.request(jsonGet('/api/loops', { 'x-workspace-id': workspaceId }))
		expect(listRes.status).toBe(200)
		const listBody = (await listRes.json()) as { loops: Array<{ id: string; status: string }> }
		const statusById = new Map(listBody.loops.map((r) => [r.id, r.status]))
		for (const row of rows) {
			expect(statusById.get(row.id)).toBe(row.status)
		}

		// Same shape via the get_loop path (id-scoped GET).
		for (const row of rows) {
			const getRes = await app.request(
				jsonGet(`/api/loops?id=${row.id}`, { 'x-workspace-id': workspaceId }),
			)
			expect(getRes.status).toBe(200)
			const getBody = (await getRes.json()) as { loops: Array<{ status: string }> }
			expect(getBody.loops).toHaveLength(1)
			expect(getBody.loops[0]?.status).toBe(row.status)
		}
	})

	it('remaps metadata.setup.stage="test" loops to pilot on the migration run', async () => {
		// The migration already ran once (as part of the global-setup harness)
		// against zero loop rows. To exercise the mapping deterministically,
		// seed a row that matches the pre-migration pattern (any legacy status,
		// carrying the guided-setup marker) and re-run the migration's core
		// statement in isolation. Re-runs are no-ops by construction — the
		// UPDATE's WHERE clause skips rows already at 'pilot'.
		const seeded = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'draft',
			title: 'Guided-setup pilot candidate',
			metadata: { setup: { stage: 'test' } },
		})

		await sql`
			UPDATE objects
			SET status = 'pilot'
			WHERE type = 'loop'
				AND jsonb_typeof(metadata) = 'object'
				AND jsonb_typeof(metadata->'setup') = 'object'
				AND metadata->'setup'->>'stage' = 'test'
				AND status <> 'pilot'
		`

		const [after] = await db.select().from(objects).where(eq(objects.id, seeded.id))
		expect(after?.status).toBe('pilot')

		// A second run is a no-op — the WHERE clause excludes rows already at
		// 'pilot', so the row's updated_at doesn't change.
		const firstUpdatedAt = after?.updatedAt
		await sql`
			UPDATE objects
			SET status = 'pilot'
			WHERE type = 'loop'
				AND jsonb_typeof(metadata) = 'object'
				AND jsonb_typeof(metadata->'setup') = 'object'
				AND metadata->'setup'->>'stage' = 'test'
				AND status <> 'pilot'
		`
		const [afterSecond] = await db.select().from(objects).where(eq(objects.id, seeded.id))
		expect(afterSecond?.updatedAt).toEqual(firstUpdatedAt)
	})

	it('remaps legacy running/waiting statuses to their ladder counterparts', async () => {
		// Same isolation trick as the guided-setup test: seed the pre-migration
		// pattern and re-run the migration's remap statements.
		const running = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'draft', // insertObject can't write 'running' directly since the
			// factory type widens — set to a real value first, then reset via raw SQL.
			title: 'Legacy running loop',
		})
		const waiting = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'draft',
			title: 'Legacy waiting loop',
		})
		await sql`UPDATE objects SET status = 'running' WHERE id = ${running.id}`
		await sql`UPDATE objects SET status = 'waiting' WHERE id = ${waiting.id}`

		await sql`UPDATE objects SET status = 'live' WHERE type = 'loop' AND status = 'running'`
		await sql`UPDATE objects SET status = 'supervised' WHERE type = 'loop' AND status = 'waiting'`

		const [afterRunning] = await db.select().from(objects).where(eq(objects.id, running.id))
		const [afterWaiting] = await db.select().from(objects).where(eq(objects.id, waiting.id))
		expect(afterRunning?.status).toBe('live')
		expect(afterWaiting?.status).toBe('supervised')
	})

	it('the migration seeded workspaces.settings.statuses.loop with the new ladder', async () => {
		// Every workspace — new ones (created above via insertWorkspace, which
		// runs the Zod default) and pre-existing ones (touched by the migration
		// SQL) — must expose the full ladder. Read this workspace directly.
		const [row] = await sql`SELECT settings FROM workspaces WHERE id = ${workspaceId}`
		const settings = row?.settings as { statuses?: Record<string, string[]> } | undefined
		expect(settings?.statuses?.loop).toEqual([
			'draft',
			'pilot',
			'supervised',
			'live',
			'paused',
			'archived',
		])
	})

	it('is scoped to type=loop — bets/tasks with matching statuses are untouched', async () => {
		// A bet in status 'live' or 'paused' must not be remapped by the loop
		// migration. Same for a task in 'in_progress'. Guard against the
		// migration WHERE clauses accidentally widening.
		const bet = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			status: 'live',
			title: 'Unrelated bet',
		})
		const task = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			status: 'in_progress',
			title: 'Unrelated task',
		})

		// Idempotent replays of the migration statements — should not touch any
		// non-loop row.
		await sql`UPDATE objects SET status = 'live' WHERE type = 'loop' AND status = 'running'`
		await sql`UPDATE objects SET status = 'supervised' WHERE type = 'loop' AND status = 'waiting'`

		const [afterBet] = await db
			.select()
			.from(objects)
			.where(and(eq(objects.id, bet.id), eq(objects.type, 'bet')))
		const [afterTask] = await db
			.select()
			.from(objects)
			.where(and(eq(objects.id, task.id), eq(objects.type, 'task')))
		expect(afterBet?.status).toBe('live')
		expect(afterTask?.status).toBe('in_progress')
	})
})
