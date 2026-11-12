import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { DATA_QUERY_PAGE_SIZE, type DataQueryResult, dataQuerySpecSchema } from '@maskin/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSnapshots } from '../../lib/data-query-snapshots'
import {
	type DataQueryRow,
	buildDataQuerySql,
	buildNextChangeSql,
	default as dataQueryRoutes,
	pageOfResult,
	parseCursor,
	shapeDataQueryResult,
} from '../../routes/data-query'
import { jsonGet } from '../helpers'
import { createTestContext, withTestEnv } from '../setup'

const WORKSPACE_ID = randomUUID()
const LOOP_ID = randomUUID()
const dialect = new PgDialect()

function specOf(input: Record<string, unknown>) {
	return dataQuerySpecSchema.parse(input)
}

function row(overrides: Partial<DataQueryRow> = {}): DataQueryRow {
	return {
		key: 'done',
		n: '3',
		s: null,
		nv: '0',
		total_n: '5',
		total_s: null,
		total_nv: '0',
		...overrides,
	}
}

function setup(executeRows: unknown[] = []) {
	const { db, mockResults } = createTestContext()
	const execute = vi.fn().mockResolvedValue(executeRows)
	// The aggregation runs inside a transaction (for its statement timeout), so the
	// transaction callback must see the same `execute` spy.
	const dbWithExecute: Database = new Proxy(db, {
		get: (target, prop) => {
			if (prop === 'execute') return execute
			if (prop === 'transaction') {
				return async (fn: (tx: Database) => Promise<unknown>) => fn(dbWithExecute)
			}
			return Reflect.get(target, prop)
		},
	}) as Database
	const app = new OpenAPIHono()
	withTestEnv(app as never, dbWithExecute)
	app.route('/api/data', dataQueryRoutes as never)
	return { app, mockResults, execute }
}

function get(spec: unknown, headers: Record<string, string> = { 'X-Workspace-Id': WORKSPACE_ID }) {
	const raw = typeof spec === 'string' ? spec : JSON.stringify(spec)
	return jsonGet(`/api/data/query?spec=${encodeURIComponent(raw)}`, headers)
}

describe('buildDataQuerySql', () => {
	it('scopes to the workspace and binds every caller value as a parameter', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({
					type: 'task',
					filters: { status: ['todo', 'done'], metadata: { priority: 'P1' } },
					group_by: 'metadata.team',
				}),
			),
		)
		expect(sql).toContain('o.workspace_id = $')
		expect(sql).not.toContain('P1')
		expect(sql).not.toContain('team')
		expect(params).toEqual(
			expect.arrayContaining([WORKSPACE_ID, 'task', 'todo', 'done', 'priority']),
		)
		expect(params).toContain(JSON.stringify('P1'))
		expect(params).toContain('team')
	})

	it('joins in_loop edges only for a loop scope', () => {
		const workspace = dialect.sqlToQuery(buildDataQuerySql(WORKSPACE_ID, specOf({ type: 'task' })))
		expect(workspace.sql).not.toContain('"relationships"')

		const loop = dialect.sqlToQuery(
			buildDataQuerySql(WORKSPACE_ID, specOf({ type: 'task', scope: LOOP_ID })),
		)
		expect(loop.sql).toContain('"relationships"')
		expect(loop.params).toEqual(expect.arrayContaining(['in_loop', LOOP_ID]))
	})

	it('caps neither the rows scanned nor the groups returned', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(WORKSPACE_ID, specOf({ type: 'task', group_by: 'status' })),
		)
		expect(sql).not.toContain('LIMIT')
		expect(sql).not.toContain('OFFSET')
		expect(params.filter((p) => typeof p === 'number')).toEqual([])
	})

	it('only sums real numbers so a text value cannot fail the cast', () => {
		const { sql } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({ type: 'bet', aggregate: { op: 'sum', field: 'budget' } }),
			),
		)
		expect(sql).toContain('jsonb_typeof(o.metadata -> $')
		expect(sql).toContain("= 'number'")
	})
})

describe('buildDataQuerySql moving dates and time buckets', () => {
	it('computes a rolling bound from the database clock instead of binding a date', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({ type: 'insight', filters: { created_after: 'now-14d' } }),
			),
		)
		expect(sql).toContain('now()')
		expect(sql).toContain('make_interval(days =>')
		expect(params).toContain(14)
		expect(params).not.toContain('now-14d')
	})

	it('starts "today" at midnight in the given timezone', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({
					type: 'insight',
					timezone: 'Europe/Oslo',
					filters: { created_after: 'today-7d' },
				}),
			),
		)
		expect(sql).toContain("date_trunc('day', now() AT TIME ZONE")
		expect(params).toContain('Europe/Oslo')
	})

	it('still binds a fixed ISO date', () => {
		const iso = '2026-10-23T00:00:00.000Z'
		const { params } = dialect.sqlToQuery(
			buildDataQuerySql(WORKSPACE_ID, specOf({ type: 'insight', filters: { created_after: iso } })),
		)
		expect(params).toContain(iso)
	})

	it('groups by a day bucket in the timezone and orders oldest first', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({ type: 'insight', group_by: 'created_at.day', timezone: 'Europe/Oslo' }),
			),
		)
		expect(sql).toContain('date_trunc($')
		expect(sql).toContain('ORDER BY g.k ASC')
		expect(params).toEqual(expect.arrayContaining(['day', 'Europe/Oslo', 'YYYY-MM-DD']))
	})

	it('rejects a bad bound, bucket or timezone at the boundary', () => {
		const bad = [
			{ type: 'task', filters: { created_after: 'yesterday' } },
			{ type: 'task', filters: { created_after: 'today-3h' } },
			{ type: 'task', group_by: 'created_at.year' },
			{ type: 'task', group_by: 'created_at.day', timezone: 'Mars/Base' },
		]
		for (const input of bad) {
			expect(dataQuerySpecSchema.safeParse(input).success).toBe(false)
		}
	})
})

describe('buildNextChangeSql', () => {
	const next = (input: Record<string, unknown>) =>
		dialect.sqlToQuery(buildNextChangeSql(WORKSPACE_ID, specOf(input))).sql

	it('has nothing to wait for when the query uses no moving dates', () => {
		expect(next({ type: 'task', filters: { status: 'done' } })).toBe('SELECT NULL::bigint AS in_ms')
	})

	it('waits for the oldest matching object to leave a rolling window', () => {
		const sql = next({ type: 'insight', filters: { created_after: 'now-7d' } })
		expect(sql).toContain('min(o.created_at)')
		expect(sql).toContain('make_interval(days =>')
		expect(sql).toContain('- now()')
	})

	it('wakes at midnight for a day chart and at the hour for an hourly one', () => {
		expect(next({ type: 'insight', group_by: 'created_at.day' })).toContain("interval '1 day'")
		expect(next({ type: 'insight', group_by: 'created_at.hour' })).toContain("interval '1 hour'")
	})

	it('wakes at midnight for a today bound', () => {
		expect(next({ type: 'task', filters: { created_after: 'today-7d' } })).toContain(
			"interval '1 day'",
		)
	})
})

describe('shapeDataQueryResult', () => {
	it('keeps the rows in the order the query returned them (time buckets come oldest first)', () => {
		const result = shapeDataQueryResult(
			[row({ key: '2026-10-29' }), row({ key: '2026-10-30' })],
			specOf({ type: 'insight', group_by: 'created_at.day' }),
		)
		expect(result.groups.map((g) => g.key)).toEqual(['2026-10-29', '2026-10-30'])
	})

	it('returns an empty total when nothing matched', () => {
		expect(shapeDataQueryResult([], specOf({ type: 'task' }))).toEqual({
			groups: [],
			total: { count: 0, value: 0 },
			next_cursor: null,
			rows_truncated: false,
			groups_truncated: false,
		})
	})

	it('turns postgres string counts into numbers and reads the total off the first row', () => {
		const result = shapeDataQueryResult(
			[row(), row({ key: 'todo', n: '2' })],
			specOf({ type: 'task', group_by: 'status' }),
		)
		expect(result.groups).toEqual([
			{ key: 'done', count: 3, value: 3 },
			{ key: 'todo', count: 2, value: 2 },
		])
		expect(result.total).toEqual({ count: 5, value: 5 })
	})

	it('averages across all groups, not per page of groups', () => {
		const result = shapeDataQueryResult(
			[
				row({ n: '2', s: '10', nv: '2', total_n: '3', total_s: '16', total_nv: '3' }),
				row({ key: 'todo', n: '1', s: '6', nv: '1', total_n: '3', total_s: '16', total_nv: '3' }),
			],
			specOf({ type: 'task', group_by: 'status', aggregate: { op: 'avg', field: 'points' } }),
		)
		expect(result.groups.map((g) => g.value)).toEqual([5, 6])
		expect(result.total.value).toBeCloseTo(16 / 3)
	})

	it('gives a null value when no row carried a number', () => {
		const result = shapeDataQueryResult(
			[row({ s: null, nv: '0', total_s: null, total_nv: '0' })],
			specOf({ type: 'task', group_by: 'status', aggregate: { op: 'sum', field: 'points' } }),
		)
		expect(result.groups[0].value).toBeNull()
		expect(result.total.value).toBeNull()
	})

	it('treats a single null-keyed row as the total when there is no group_by', () => {
		const result = shapeDataQueryResult(
			[row({ key: null, n: '4', total_n: '4' })],
			specOf({ type: 'task' }),
		)
		expect(result.groups).toEqual([])
		expect(result.total.count).toBe(4)
	})

	it('keeps every group and never flags a cap', () => {
		const rows = Array.from({ length: DATA_QUERY_PAGE_SIZE * 3 }, (_, i) =>
			row({ key: `g${i}`, n: '1', total_n: String(DATA_QUERY_PAGE_SIZE * 3) }),
		)
		const result = shapeDataQueryResult(rows, specOf({ type: 'task', group_by: 'metadata.team' }))
		expect(result.groups).toHaveLength(DATA_QUERY_PAGE_SIZE * 3)
		expect(result.next_cursor).toBeNull()
		expect(result.rows_truncated).toBe(false)
		expect(result.groups_truncated).toBe(false)
	})
})

describe('parseCursor', () => {
	const id = randomUUID()

	it('reads the snapshot id and the offset', () => {
		expect(parseCursor(`${id}.250`)).toEqual({ snapshotId: id, offset: 250 })
	})

	it.each(['', 'abc', `${id}`, `${id}.`, `${id}.-1`, `${id}.1.2`, `${id}.9999999999`, 'x.5'])(
		'rejects %j',
		(bad) => {
			expect(parseCursor(bad)).toBeNull()
		},
	)
})

describe('pageOfResult', () => {
	const full = (n: number): DataQueryResult => ({
		groups: Array.from({ length: n }, (_, i) => ({ key: `g${i}`, count: 1, value: 1 })),
		total: { count: n, value: n },
		next_cursor: null,
		rows_truncated: false,
		groups_truncated: false,
	})

	it('cuts a page, points at the next one, and keeps the totals for every group', () => {
		const page = pageOfResult(full(5), 0, 2, 'snap')
		expect(page.groups.map((g) => g.key)).toEqual(['g0', 'g1'])
		expect(page.next_cursor).toBe('snap.2')
		expect(page.groups_truncated).toBe(true)
		expect(page.total.count).toBe(5)
	})

	it('has no cursor on the last page', () => {
		const page = pageOfResult(full(5), 4, 2, 'snap')
		expect(page.groups.map((g) => g.key)).toEqual(['g4'])
		expect(page.next_cursor).toBeNull()
		expect(page.groups_truncated).toBe(false)
	})

	it('has no cursor when the whole answer fits, even without a snapshot', () => {
		const page = pageOfResult(full(2), 0, 5, null)
		expect(page.groups).toHaveLength(2)
		expect(page.next_cursor).toBeNull()
	})

	it('returns an empty page past the end', () => {
		const page = pageOfResult(full(2), 10, 5, 'snap')
		expect(page.groups).toEqual([])
		expect(page.next_cursor).toBeNull()
	})
})

describe('GET /api/data/query', () => {
	let ctx: ReturnType<typeof setup>

	beforeEach(() => {
		clearSnapshots()
		ctx = setup([row()])
	})

	describe('paging', () => {
		const groupRows = (n: number) =>
			Array.from({ length: n }, (_, i) => row({ key: `g${i}`, n: '1', total_n: String(n) }))
		const page = (spec: unknown, params: string, headers?: Record<string, string>) => {
			const raw = encodeURIComponent(JSON.stringify(spec))
			return jsonGet(`/api/data/query?spec=${raw}&${params}`, {
				'X-Workspace-Id': WORKSPACE_ID,
				...headers,
			})
		}
		const spec = { type: 'task', group_by: 'metadata.person' }

		it('reads every page from the one query the first page ran', async () => {
			ctx = setup(groupRows(5))
			const first = await (await ctx.app.request(page(spec, 'limit=2'))).json()
			expect(first.groups.map((g: { key: string }) => g.key)).toEqual(['g0', 'g1'])
			expect(first.groups_truncated).toBe(true)

			const second = await (
				await ctx.app.request(page(spec, `limit=2&cursor=${first.next_cursor}`))
			).json()
			expect(second.groups.map((g: { key: string }) => g.key)).toEqual(['g2', 'g3'])

			const last = await (
				await ctx.app.request(page(spec, `limit=2&cursor=${second.next_cursor}`))
			).json()
			expect(last.groups.map((g: { key: string }) => g.key)).toEqual(['g4'])
			expect(last.next_cursor).toBeNull()
			expect(last.total.count).toBe(5)
			// The two later pages came out of the snapshot: one aggregation for all three.
			expect(ctx.execute).toHaveBeenCalledTimes(2) // SET LOCAL statement_timeout + the query
		})

		it('runs the first page fresh every time, so a changed number is never served stale', async () => {
			ctx = setup(groupRows(5))
			await ctx.app.request(page(spec, 'limit=2'))
			await ctx.app.request(page(spec, 'limit=2'))
			expect(ctx.execute).toHaveBeenCalledTimes(4)
		})

		it('does not keep a snapshot when everything fits on one page', async () => {
			ctx = setup(groupRows(3))
			const body = await (await ctx.app.request(page(spec, 'limit=10'))).json()
			expect(body.groups).toHaveLength(3)
			expect(body.next_cursor).toBeNull()
			expect(body.groups_truncated).toBe(false)
		})

		it('recomputes, from the cursor onward, when the snapshot is gone', async () => {
			ctx = setup(groupRows(5))
			const stale = `${randomUUID()}.2`
			const body = await (await ctx.app.request(page(spec, `limit=2&cursor=${stale}`))).json()
			expect(body.groups.map((g: { key: string }) => g.key)).toEqual(['g2', 'g3'])
			expect(body.next_cursor).toMatch(/\.4$/)
			expect(ctx.execute).toHaveBeenCalledTimes(2)
		})

		it('never serves a snapshot to another query', async () => {
			ctx = setup(groupRows(5))
			const first = await (await ctx.app.request(page(spec, 'limit=2'))).json()
			await ctx.app.request(
				page({ ...spec, group_by: 'metadata.channel' }, `limit=2&cursor=${first.next_cursor}`),
			)
			expect(ctx.execute).toHaveBeenCalledTimes(4)
		})

		it.each([['not-a-cursor'], [`${randomUUID()}.-3`]])('rejects the cursor %s', async (cursor) => {
			const res = await ctx.app.request(page(spec, `cursor=${cursor}`))
			expect(res.status).toBe(400)
			expect(ctx.execute).not.toHaveBeenCalled()
		})

		it.each([['0'], ['-1'], ['abc'], ['1.5'], ['1001']])('rejects limit=%s', async (limit) => {
			const res = await ctx.app.request(page(spec, `limit=${limit}`))
			expect(res.status).toBe(400)
			expect(ctx.execute).not.toHaveBeenCalled()
		})
	})

	it('returns grouped totals', async () => {
		const res = await ctx.app.request(get({ type: 'task', group_by: 'status' }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.groups).toEqual([{ key: 'done', count: 3, value: 3 }])
		expect(body.total.count).toBe(5)
		expect(body.next_cursor).toBeNull()
		expect(ctx.execute).toHaveBeenCalledTimes(2) // SET LOCAL statement_timeout + the query
	})

	it('requires the workspace header', async () => {
		const res = await ctx.app.request(get({ type: 'task' }, {}))
		expect(res.status).toBe(400)
		expect(ctx.execute).not.toHaveBeenCalled()
	})

	it('rejects a spec that is not JSON', async () => {
		const res = await ctx.app.request(get('{nope'))
		expect(res.status).toBe(400)
		expect(ctx.execute).not.toHaveBeenCalled()
	})

	it.each([
		['an unknown key', { type: 'task', rows: true }],
		['a metadata field that is not a plain name', { type: 'task', group_by: "metadata.x'; --" }],
		['sum without a field', { type: 'task', aggregate: { op: 'sum' } }],
		[
			'too many metadata filters',
			{
				type: 'task',
				filters: {
					metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, 'x'])),
				},
			},
		],
		['a loop scope that is not a uuid', { type: 'task', scope: 'everything' }],
	])('rejects %s', async (_label, spec) => {
		const res = await ctx.app.request(get(spec))
		expect(res.status).toBe(400)
		expect(ctx.execute).not.toHaveBeenCalled()
	})

	it('returns 404 when the loop scope is not a loop in this workspace', async () => {
		ctx.mockResults.select = []
		const res = await ctx.app.request(get({ type: 'task', scope: LOOP_ID }))
		expect(res.status).toBe(404)
		expect(ctx.execute).not.toHaveBeenCalled()
	})

	it('runs the query once the loop scope resolves', async () => {
		ctx.mockResults.select = [{ id: LOOP_ID }]
		const res = await ctx.app.request(get({ type: 'task', scope: LOOP_ID }))
		expect(res.status).toBe(200)
		expect(ctx.execute).toHaveBeenCalledTimes(2)
	})
})
