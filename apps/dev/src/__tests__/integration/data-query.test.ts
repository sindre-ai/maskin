import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import {
	DATA_QUERY_MAX_GROUPS,
	DATA_QUERY_MAX_ROWS,
	type DataQueryResult,
	type DataQuerySpec,
} from '@maskin/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	buildObject,
	insertActor,
	insertObject,
	insertRelationship,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The route's SQL is hand-built (CTEs, window functions, bound parameters inside
// date_trunc / AT TIME ZONE / make_interval), so the mocked route tests can only check
// its text. This runs it against real Postgres: scope, filters, the numeric casts, time
// zones, the row and group caps, and the next-change arithmetic.
const { default: dataQueryRoutes } = await import('../../routes/data-query')

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
	app.route('/api/data', dataQueryRoutes)
	return app
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('Data query integration', () => {
	let workspaceId: string
	let actorId: string
	let app: ReturnType<typeof makeApp>

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		app = makeApp(actorId)
	})

	async function query(spec: DataQuerySpec, ws = workspaceId) {
		const res = await app.request(
			jsonGet(`/api/data/query?spec=${encodeURIComponent(JSON.stringify(spec))}`, {
				'x-workspace-id': ws,
			}),
		)
		return res
	}

	async function result(spec: DataQuerySpec) {
		const res = await query(spec)
		expect(res.status).toBe(200)
		return (await res.json()) as DataQueryResult
	}

	async function nextChange(spec: DataQuerySpec) {
		const res = await app.request(
			jsonGet(`/api/data/next-change?spec=${encodeURIComponent(JSON.stringify(spec))}`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { in_ms: number | null }).in_ms
	}

	async function insertLoop(ws = workspaceId, by = actorId) {
		return insertObject(db, ws, by, { type: 'loop', status: 'learning' })
	}

	async function link(loopId: string, taskId: string) {
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: loopId,
			targetType: 'object',
			targetId: taskId,
			type: 'in_loop',
		})
	}

	/** Many rows at once, in chunks to stay under Postgres's bind-parameter limit. */
	async function bulkInsertTasks(count: number, overrides: (i: number) => Record<string, unknown>) {
		const rows = Array.from({ length: count }, (_, i) =>
			buildObject({ workspaceId, createdBy: actorId, type: 'task', ...overrides(i) }),
		)
		for (let i = 0; i < rows.length; i += 1000) {
			await db.insert(objects).values(rows.slice(i, i + 1000))
		}
	}

	describe('scope and grouping', () => {
		it('counts only the members of the scoped loop, in this workspace', async () => {
			const loop = await insertLoop()
			const otherLoop = await insertLoop()
			const inLoopA = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'done' })
			const inLoopB = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'done' })
			const inOtherLoop = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'done',
			})
			await insertObject(db, workspaceId, actorId, { type: 'task', status: 'done' }) // in no loop
			await link(loop.id, inLoopA.id)
			await link(loop.id, inLoopB.id)
			await link(otherLoop.id, inOtherLoop.id)

			// Another workspace with a same-typed object must never be counted.
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			await insertObject(db, otherWs.id, otherActor.id, { type: 'task', status: 'done' })

			const scoped = await result({ scope: loop.id, type: 'task' })
			expect(scoped.total.count).toBe(2)
			const wholeWorkspace = await result({ scope: 'workspace', type: 'task' })
			expect(wholeWorkspace.total.count).toBe(4)
		})

		it('returns 404 for a loop id that belongs to another workspace, and for a non-loop', async () => {
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			const foreignLoop = await insertLoop(otherWs.id, otherActor.id)
			const notALoop = await insertObject(db, workspaceId, actorId, { type: 'task' })

			expect((await query({ scope: foreignLoop.id, type: 'task' })).status).toBe(404)
			expect((await query({ scope: notALoop.id, type: 'task' })).status).toBe(404)
		})

		it('groups by status with counts, largest first', async () => {
			for (const status of ['done', 'done', 'done', 'todo', 'todo', 'in_progress']) {
				await insertObject(db, workspaceId, actorId, { type: 'task', status })
			}
			const r = await result({ scope: 'workspace', type: 'task', group_by: 'status' })
			expect(r.groups).toEqual([
				{ key: 'done', count: 3, value: 3 },
				{ key: 'todo', count: 2, value: 2 },
				{ key: 'in_progress', count: 1, value: 1 },
			])
			expect(r.total).toEqual({ count: 6, value: 6 })
			expect(r.rows_truncated).toBe(false)
			expect(r.groups_truncated).toBe(false)
		})

		it('groups by a metadata field', async () => {
			for (const channel of ['email', 'email', 'chat']) {
				await insertObject(db, workspaceId, actorId, { type: 'task', metadata: { channel } })
			}
			await insertObject(db, workspaceId, actorId, { type: 'task' }) // no metadata at all
			const r = await result({ scope: 'workspace', type: 'task', group_by: 'metadata.channel' })
			expect(r.groups.map((g) => [g.key, g.count])).toEqual([
				['email', 2],
				['chat', 1],
				[null, 1],
			])
		})

		it('returns zero, not an error, when nothing matches', async () => {
			const r = await result({ scope: 'workspace', type: 'task', group_by: 'status' })
			expect(r).toEqual({
				groups: [],
				total: { count: 0, value: 0 },
				rows_truncated: false,
				groups_truncated: false,
			})
		})
	})

	describe('sum and avg', () => {
		beforeEach(async () => {
			// Only real JSON numbers count. "abc", null and a missing field add nothing
			// and must not fail the cast for the whole query.
			for (const metadata of [
				{ amount: 10 },
				{ amount: 20 },
				{ amount: 'abc' },
				{ amount: null },
				{},
			]) {
				await insertObject(db, workspaceId, actorId, { type: 'task', metadata })
			}
		})

		it('sums only numeric values', async () => {
			const r = await result({
				scope: 'workspace',
				type: 'task',
				aggregate: { op: 'sum', field: 'amount' },
			})
			expect(r.total).toEqual({ count: 5, value: 30 })
		})

		it('averages over the numeric values, not over every row', async () => {
			const r = await result({
				scope: 'workspace',
				type: 'task',
				aggregate: { op: 'avg', field: 'amount' },
			})
			expect(r.total.value).toBe(15)
		})

		it('returns null, not 0, when no row has a numeric value', async () => {
			const r = await result({
				scope: 'workspace',
				type: 'task',
				filters: { metadata: { amount: 'abc' } },
				aggregate: { op: 'avg', field: 'amount' },
			})
			expect(r.total).toEqual({ count: 1, value: null })
		})
	})

	describe('filters', () => {
		it('filters by one status and by a list of statuses', async () => {
			for (const status of ['done', 'todo', 'in_progress']) {
				await insertObject(db, workspaceId, actorId, { type: 'task', status })
			}
			expect(
				(await result({ scope: 'workspace', type: 'task', filters: { status: 'done' } })).total
					.count,
			).toBe(1)
			expect(
				(
					await result({
						scope: 'workspace',
						type: 'task',
						filters: { status: ['done', 'todo'] },
					})
				).total.count,
			).toBe(2)
		})

		it('matches metadata by exact JSON value, so 5 is not "5"', async () => {
			await insertObject(db, workspaceId, actorId, { type: 'task', metadata: { priority: 5 } })
			await insertObject(db, workspaceId, actorId, { type: 'task', metadata: { priority: '5' } })
			await insertObject(db, workspaceId, actorId, { type: 'task', metadata: { priority: true } })
			const count = async (value: string | number | boolean) =>
				(
					await result({
						scope: 'workspace',
						type: 'task',
						filters: { metadata: { priority: value } },
					})
				).total.count
			expect(await count(5)).toBe(1)
			expect(await count('5')).toBe(1)
			expect(await count(true)).toBe(1)
		})

		it('treats a fixed date window as half open: after is inclusive, before is exclusive', async () => {
			for (const createdAt of [
				'2026-03-01T00:00:00.000Z',
				'2026-03-02T00:00:00.000Z',
				'2026-03-03T00:00:00.000Z',
			]) {
				await insertObject(db, workspaceId, actorId, {
					type: 'task',
					createdAt: new Date(createdAt),
				})
			}
			const r = await result({
				scope: 'workspace',
				type: 'task',
				filters: {
					created_after: '2026-03-01T00:00:00.000Z',
					created_before: '2026-03-03T00:00:00.000Z',
				},
			})
			expect(r.total.count).toBe(2)
		})

		it('resolves a relative bound against the database clock', async () => {
			const now = Date.now()
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date(now - 10 * DAY_MS),
			})
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date(now - 1 * DAY_MS),
			})
			const r = await result({
				scope: 'workspace',
				type: 'task',
				filters: { created_after: 'now-7d' },
			})
			expect(r.total.count).toBe(1)
		})

		it('starts "today" at midnight in the query timezone', async () => {
			// An object created now is "today" in every zone and one from 3 days ago never is,
			// so the count must be 1 whichever zone's midnight the bound resolves to.
			await insertObject(db, workspaceId, actorId, { type: 'task' })
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date(Date.now() - 3 * DAY_MS),
			})
			for (const timezone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
				const r = await result({
					scope: 'workspace',
					type: 'task',
					timezone,
					filters: { created_after: 'today' },
				})
				expect(r.total.count).toBe(1)
			}
		})
	})

	describe('time buckets', () => {
		it('buckets by day in the requested timezone, oldest first', async () => {
			// Auckland is UTC+13 in March: 23:30 UTC on 1 March is already 2 March there, while
			// 10:00 UTC is 23:00 the same day.
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date('2026-03-01T23:30:00.000Z'),
			})
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date('2026-03-01T10:00:00.000Z'),
			})
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date('2026-03-03T10:00:00.000Z'),
			})

			const utc = await result({
				scope: 'workspace',
				type: 'task',
				group_by: 'created_at.day',
				timezone: 'UTC',
			})
			expect(utc.groups.map((g) => [g.key, g.count])).toEqual([
				['2026-03-01', 2],
				['2026-03-03', 1],
			])

			const auckland = await result({
				scope: 'workspace',
				type: 'task',
				group_by: 'created_at.day',
				timezone: 'Pacific/Auckland',
			})
			expect(auckland.groups.map((g) => [g.key, g.count])).toEqual([
				['2026-03-01', 1],
				['2026-03-02', 1],
				['2026-03-03', 1],
			])
		})

		it('buckets by month and by hour with sortable keys', async () => {
			for (const createdAt of ['2026-01-31T23:00:00.000Z', '2026-02-01T00:30:00.000Z']) {
				await insertObject(db, workspaceId, actorId, {
					type: 'task',
					createdAt: new Date(createdAt),
				})
			}
			const month = await result({
				scope: 'workspace',
				type: 'task',
				group_by: 'created_at.month',
			})
			expect(month.groups.map((g) => g.key)).toEqual(['2026-01', '2026-02'])
			const hour = await result({ scope: 'workspace', type: 'task', group_by: 'created_at.hour' })
			expect(hour.groups.map((g) => g.key)).toEqual(['2026-01-31T23:00', '2026-02-01T00:00'])
		})
	})

	describe('caps', () => {
		it('flags rows_truncated and totals only the rows it scanned when over the row cap', async () => {
			await bulkInsertTasks(DATA_QUERY_MAX_ROWS + 1, () => ({}))
			const r = await result({ scope: 'workspace', type: 'task' })
			expect(r.rows_truncated).toBe(true)
			expect(r.total.count).toBe(DATA_QUERY_MAX_ROWS)
		})

		it('does not flag rows_truncated at exactly the row cap', async () => {
			await bulkInsertTasks(DATA_QUERY_MAX_ROWS, () => ({}))
			const r = await result({ scope: 'workspace', type: 'task' })
			expect(r.rows_truncated).toBe(false)
			expect(r.total.count).toBe(DATA_QUERY_MAX_ROWS)
		})

		it('returns the largest groups and flags groups_truncated past the group cap', async () => {
			const groupCount = DATA_QUERY_MAX_GROUPS + 1
			await bulkInsertTasks(groupCount + 2, (i) => ({
				// 51 groups; group k07 gets two extra rows so it is the largest.
				metadata: { k: `k${String(i < groupCount ? i : 7).padStart(2, '0')}` },
			}))
			const r = await result({ scope: 'workspace', type: 'task', group_by: 'metadata.k' })
			expect(r.groups_truncated).toBe(true)
			expect(r.groups).toHaveLength(DATA_QUERY_MAX_GROUPS)
			expect(r.groups[0]).toMatchObject({ key: 'k07', count: 3 })
			// The total still covers every group, so it is larger than the returned groups sum.
			expect(r.total.count).toBe(groupCount + 2)
		})

		it('keeps the newest buckets when time buckets exceed the group cap', async () => {
			const start = Date.UTC(2026, 0, 1)
			await bulkInsertTasks(DATA_QUERY_MAX_GROUPS + 5, (i) => ({
				createdAt: new Date(start + i * DAY_MS),
			}))
			const r = await result({ scope: 'workspace', type: 'task', group_by: 'created_at.day' })
			expect(r.groups_truncated).toBe(true)
			expect(r.groups).toHaveLength(DATA_QUERY_MAX_GROUPS)
			const keys = r.groups.map((g) => g.key as string)
			expect([...keys].sort()).toEqual(keys) // oldest first
			expect(keys.at(-1)).toBe(
				new Date(start + (DATA_QUERY_MAX_GROUPS + 4) * DAY_MS).toISOString().slice(0, 10),
			)
		})
	})

	describe('next-change', () => {
		it('says when the oldest object leaves a rolling window', async () => {
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				createdAt: new Date(Date.now() - 6 * DAY_MS),
			})
			const ms = await nextChange({
				scope: 'workspace',
				type: 'task',
				filters: { created_after: 'now-7d' },
			})
			expect(ms).not.toBeNull()
			// Created 6 days ago, leaves a 7 day window in about a day.
			expect(ms as number).toBeGreaterThan(DAY_MS - 5 * 60 * 1000)
			expect(ms as number).toBeLessThanOrEqual(DAY_MS)
		})

		it('is null when the window has no objects in it, and when no bound moves', async () => {
			expect(
				await nextChange({
					scope: 'workspace',
					type: 'task',
					filters: { created_after: 'now-7d' },
				}),
			).toBeNull()
			await insertObject(db, workspaceId, actorId, { type: 'task' })
			expect(
				await nextChange({ scope: 'workspace', type: 'task', filters: { status: 'done' } }),
			).toBeNull()
		})

		it('points at the next midnight for a day-bucketed view, never more than a day away', async () => {
			const ms = await nextChange({
				scope: 'workspace',
				type: 'task',
				group_by: 'created_at.day',
			})
			expect(ms).not.toBeNull()
			expect(ms as number).toBeGreaterThanOrEqual(0)
			expect(ms as number).toBeLessThanOrEqual(DAY_MS)
		})

		it('returns 404 for a loop that is not in this workspace', async () => {
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			const foreignLoop = await insertLoop(otherWs.id, otherActor.id)
			const res = await app.request(
				jsonGet(
					`/api/data/next-change?spec=${encodeURIComponent(
						JSON.stringify({ scope: foreignLoop.id, type: 'task', group_by: 'created_at.day' }),
					)}`,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(404)
		})
	})
})
