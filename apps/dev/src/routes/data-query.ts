import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import {
	DATA_QUERY_MAX_GROUPS,
	DATA_QUERY_MAX_ROWS,
	type DataQueryResult,
	type DataQuerySpec,
	createApiError,
	dataQueryResultSchema,
	dataQuerySpecSchema,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { formatZodError, validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

/** Mirrors LOOP_MEMBERSHIP_RELATIONSHIP_TYPE in `./loops.ts`. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

type SqlFragment = ReturnType<typeof sql>

/**
 * One grouped aggregation over `objects`, built so the whole query runs in
 * Postgres and at most DATA_QUERY_MAX_GROUPS rows come back. Every caller-supplied
 * value (type, status, metadata field names and values, dates, loop id) is a
 * bound parameter; field names are already restricted to
 * SAFE_METADATA_FIELD_NAME_RE by the spec schema and are still never spliced
 * into the SQL text.
 *
 * Scanning is capped at DATA_QUERY_MAX_ROWS (by id, so the cut is stable): the
 * extra row fetched past the cap exists only to report `rows_truncated`.
 */
export function buildDataQuerySql(workspaceId: string, spec: DataQuerySpec): SqlFragment {
	const op = spec.aggregate?.op ?? 'count'
	const aggField = spec.aggregate?.field
	const filters = spec.filters ?? {}

	const from =
		spec.scope === 'workspace'
			? sql`${objects} o`
			: sql`${objects} o
				JOIN ${relationships} r ON r.target_id = o.id
					AND r.type = ${LOOP_MEMBERSHIP_RELATIONSHIP_TYPE}
					AND r.source_id = ${spec.scope}::uuid`

	const where: SqlFragment[] = [
		sql`o.workspace_id = ${workspaceId}::uuid`,
		sql`o.type = ${spec.type}`,
	]
	if (filters.status !== undefined) {
		const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
		where.push(
			sql`o.status IN (${sql.join(
				statuses.map((s) => sql`${s}`),
				sql`, `,
			)})`,
		)
	}
	for (const [field, value] of Object.entries(filters.metadata ?? {})) {
		where.push(sql`o.metadata -> ${field}::text = ${JSON.stringify(value)}::jsonb`)
	}
	if (filters.created_after) where.push(sql`o.created_at >= ${filters.created_after}::timestamptz`)
	if (filters.created_before) where.push(sql`o.created_at < ${filters.created_before}::timestamptz`)
	if (filters.updated_after) where.push(sql`o.updated_at >= ${filters.updated_after}::timestamptz`)
	if (filters.updated_before) where.push(sql`o.updated_at < ${filters.updated_before}::timestamptz`)

	let keyExpr: SqlFragment = sql`NULL::text`
	if (spec.group_by === 'status') keyExpr = sql`o.status`
	else if (spec.group_by === 'type') keyExpr = sql`o.type`
	else if (spec.group_by?.startsWith('metadata.')) {
		keyExpr = sql`o.metadata ->> ${spec.group_by.slice('metadata.'.length)}::text`
	}

	// Only real JSON numbers count: a field holding "abc" or null contributes
	// nothing instead of failing the cast for the whole query.
	const valueExpr: SqlFragment =
		op === 'count' || !aggField
			? sql`NULL::numeric`
			: sql`CASE WHEN jsonb_typeof(o.metadata -> ${aggField}::text) = 'number'
				THEN (o.metadata ->> ${aggField}::text)::numeric END`

	return sql`
		WITH picked AS (
			SELECT o.id, ${keyExpr} AS k, ${valueExpr} AS v
			FROM ${from}
			WHERE ${sql.join(where, sql` AND `)}
			ORDER BY o.id
			LIMIT ${DATA_QUERY_MAX_ROWS + 1}
		), ranked AS (
			SELECT k, v, row_number() OVER (ORDER BY id) AS rn FROM picked
		), grouped AS (
			SELECT k, count(*) AS n, sum(v) AS s, count(v) AS nv
			FROM ranked
			WHERE rn <= ${DATA_QUERY_MAX_ROWS}
			GROUP BY k
		)
		SELECT g.k AS key, g.n, g.s, g.nv,
			sum(g.n) OVER () AS total_n,
			sum(g.s) OVER () AS total_s,
			sum(g.nv) OVER () AS total_nv,
			count(*) OVER () AS group_count,
			(SELECT count(*) > ${DATA_QUERY_MAX_ROWS} FROM picked) AS rows_truncated
		FROM grouped g
		ORDER BY g.n DESC, g.k ASC NULLS LAST
		LIMIT ${DATA_QUERY_MAX_GROUPS}
	`
}

export type DataQueryRow = {
	key: string | null
	n: number | string
	s: number | string | null
	nv: number | string
	total_n: number | string
	total_s: number | string | null
	total_nv: number | string
	group_count: number | string
	rows_truncated: boolean
}

function valueFor(op: 'count' | 'sum' | 'avg', n: number, s: number | null, nv: number) {
	if (op === 'count') return n
	if (s === null || nv === 0) return null
	return op === 'sum' ? s : s / nv
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

/** Turns the grouped rows into the response. No rows means nothing matched. */
export function shapeDataQueryResult(rows: DataQueryRow[], spec: DataQuerySpec): DataQueryResult {
	const op = spec.aggregate?.op ?? 'count'
	const first = rows[0]
	if (!first) {
		return {
			groups: [],
			total: { count: 0, value: op === 'count' ? 0 : null },
			rows_truncated: false,
			groups_truncated: false,
		}
	}
	return {
		// Without a group_by the single null-keyed row is the total, not a group.
		groups: spec.group_by
			? rows.map((r) => ({
					key: r.key,
					count: Number(r.n),
					value: valueFor(op, Number(r.n), num(r.s), Number(r.nv)),
				}))
			: [],
		total: {
			count: Number(first.total_n),
			value: valueFor(op, Number(first.total_n), num(first.total_s), Number(first.total_nv)),
		},
		rows_truncated: first.rows_truncated === true,
		groups_truncated: Number(first.group_count) > DATA_QUERY_MAX_GROUPS,
	}
}

const querySchema = z.object({
	spec: z.string().min(2).max(4000).openapi({
		description:
			'JSON-encoded query: { scope, type, filters, group_by, aggregate }. See the query_data MCP tool.',
	}),
})

const dataQueryRoute = createRoute({
	method: 'get',
	path: '/query',
	tags: ['data'],
	summary: 'Read-only grouped aggregation over objects',
	description:
		'Counts, sums or averages objects of one type, optionally grouped by status, type or a metadata field and scoped to the workspace or one loop. Aggregation runs in the database; scanned rows and returned groups are capped and flagged when the cap is hit.',
	request: { headers: workspaceIdHeader, query: querySchema },
	responses: {
		200: {
			description: 'Grouped totals',
			content: { 'application/json': { schema: dataQueryResultSchema } },
		},
		400: {
			description: 'Invalid query',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Loop scope not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(dataQueryRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { spec: rawSpec } = c.req.valid('query')

	let json: unknown
	try {
		json = JSON.parse(rawSpec)
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'spec must be valid JSON'), 400)
	}
	const parsed = dataQuerySpecSchema.safeParse(json)
	if (!parsed.success) {
		return c.json(
			createApiError('VALIDATION_ERROR', 'Invalid query', formatZodError(parsed.error)),
			400,
		)
	}
	const spec = parsed.data

	if (spec.scope !== 'workspace') {
		const [loop] = await db
			.select({ id: objects.id })
			.from(objects)
			.where(
				and(
					eq(objects.id, spec.scope),
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'loop'),
				),
			)
			.limit(1)
		if (!loop) return c.json(createApiError('NOT_FOUND', 'Loop not found'), 404)
	}

	const rows = await db.execute<DataQueryRow>(buildDataQuerySql(workspaceId, spec))
	return c.json(shapeDataQueryResult(Array.from(rows), spec), 200)
}) as RouteHandler<typeof dataQueryRoute, Env>)

export default app
