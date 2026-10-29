import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { DATA_QUERY_MAX_GROUPS, DATA_QUERY_MAX_ROWS, dataQuerySpecSchema } from '@maskin/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type DataQueryRow,
	buildDataQuerySql,
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

describe('shapeDataQueryResult', () => {
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
