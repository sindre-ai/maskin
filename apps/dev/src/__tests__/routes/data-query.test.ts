import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { DATA_QUERY_MAX_GROUPS, DATA_QUERY_MAX_ROWS, dataQuerySpecSchema } from '@maskin/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type DataQueryRow,
	buildDataQuerySql,
	buildNextChangeSql,
	default as dataQueryRoutes,
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
		group_count: '2',
		rows_truncated: false,
		...overrides,
	}
}

function setup(executeRows: unknown[] = []) {
	const { db, mockResults } = createTestContext()
	const execute = vi.fn().mockResolvedValue(executeRows)
	const dbWithExecute = new Proxy(db, {
		get: (target, prop) => (prop === 'execute' ? execute : Reflect.get(target, prop)),
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

	it('caps the rows scanned and the groups returned', () => {
		const { params } = dialect.sqlToQuery(buildDataQuerySql(WORKSPACE_ID, specOf({ type: 'task' })))
		expect(params).toContain(DATA_QUERY_MAX_ROWS + 1)
		expect(params).toContain(DATA_QUERY_MAX_ROWS)
		expect(params).toContain(DATA_QUERY_MAX_GROUPS)
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

	it('groups by a day bucket in the timezone and orders newest first for the cap', () => {
		const { sql, params } = dialect.sqlToQuery(
			buildDataQuerySql(
				WORKSPACE_ID,
				specOf({ type: 'insight', group_by: 'created_at.day', timezone: 'Europe/Oslo' }),
			),
		)
		expect(sql).toContain('date_trunc($')
		expect(sql).toContain('ORDER BY g.k DESC')
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
	it('returns time buckets oldest first', () => {
		const result = shapeDataQueryResult(
			[row({ key: '2026-10-30' }), row({ key: '2026-10-29' })],
			specOf({ type: 'insight', group_by: 'created_at.day' }),
		)
		expect(result.groups.map((g) => g.key)).toEqual(['2026-10-29', '2026-10-30'])
	})

	it('returns an empty total when nothing matched', () => {
		expect(shapeDataQueryResult([], specOf({ type: 'task' }))).toEqual({
			groups: [],
			total: { count: 0, value: 0 },
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

	it('flags both caps', () => {
		const result = shapeDataQueryResult(
			[row({ rows_truncated: true, group_count: String(DATA_QUERY_MAX_GROUPS + 1) })],
			specOf({ type: 'task', group_by: 'status' }),
		)
		expect(result.rows_truncated).toBe(true)
		expect(result.groups_truncated).toBe(true)
	})
})

describe('GET /api/data/query', () => {
	let ctx: ReturnType<typeof setup>

	beforeEach(() => {
		ctx = setup([row()])
	})

	it('returns grouped totals', async () => {
		const res = await ctx.app.request(get({ type: 'task', group_by: 'status' }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.groups).toEqual([{ key: 'done', count: 3, value: 3 }])
		expect(body.total.count).toBe(5)
		expect(ctx.execute).toHaveBeenCalledOnce()
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
		expect(ctx.execute).toHaveBeenCalledOnce()
	})
})
