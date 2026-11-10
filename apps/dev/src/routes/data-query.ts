import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import {
	DATA_QUERY_MAX_PAGE_SIZE,
	DATA_QUERY_PAGE_SIZE,
	type DataQueryResult,
	type DataQuerySpec,
	type DataQueryTimeUnit,
	type RelativeBound,
	createApiError,
	dataQueryResultSchema,
	dataQuerySpecSchema,
	parseRelativeBound,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { readSnapshot, saveSnapshot } from '../lib/data-query-snapshots'
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

type TimeBucket = { column: 'created_at' | 'updated_at'; unit: DataQueryTimeUnit }

/** `created_at.day` -> { column, unit }; null for every other group_by. */
function timeBucket(groupBy: string | undefined): TimeBucket | null {
	const m = groupBy ? /^(created_at|updated_at)\.(hour|day|week|month)$/.exec(groupBy) : null
	return m ? { column: m[1] as TimeBucket['column'], unit: m[2] as DataQueryTimeUnit } : null
}

// Bucket keys are the bucket's start in the query's timezone, sortable as text.
const BUCKET_KEY_FORMAT: Record<DataQueryTimeUnit, string> = {
	hour: 'YYYY-MM-DD"T"HH24:00',
	day: 'YYYY-MM-DD',
	week: 'YYYY-MM-DD',
	month: 'YYYY-MM',
}

/**
 * A date filter value as SQL. A fixed ISO datetime is one bound parameter; a relative
 * bound ("now-7d", "today") is computed from the database clock at query time, so a
 * saved view never goes stale. `today` is midnight today in `tz`.
 */
function boundSql(value: string, tz: string): SqlFragment {
	const rel = parseRelativeBound(value)
	if (!rel) return sql`${value}::timestamptz`
	const base =
		rel.base === 'now'
			? sql`now()`
			: sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`
	if (rel.amount === 0) return base
	return sql`(${base} - ${intervalSql(rel)})`
}

function intervalSql(rel: RelativeBound): SqlFragment {
	const n = rel.amount
	if (rel.unit === 'h') return sql`make_interval(hours => ${n}::int)`
	if (rel.unit === 'd') return sql`make_interval(days => ${n}::int)`
	if (rel.unit === 'w') return sql`make_interval(weeks => ${n}::int)`
	return sql`make_interval(months => ${n}::int)`
}

/** The FROM and WHERE every query over a spec shares. */
function fromAndWhere(workspaceId: string, spec: DataQuerySpec) {
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
	const tz = spec.timezone ?? 'UTC'
	if (filters.created_after) where.push(sql`o.created_at >= ${boundSql(filters.created_after, tz)}`)
	if (filters.created_before)
		where.push(sql`o.created_at < ${boundSql(filters.created_before, tz)}`)
	if (filters.updated_after) where.push(sql`o.updated_at >= ${boundSql(filters.updated_after, tz)}`)
	if (filters.updated_before)
		where.push(sql`o.updated_at < ${boundSql(filters.updated_before, tz)}`)

	return { from, where, tz }
}

/**
 * How many milliseconds from now the answer to this spec can change with no write at
 * all, because time passed; null when it cannot. Used by the loop page only, so a view that
 * shows "last 7 days" updates itself when an object ages out, or when a day-by-day
 * chart rolls over at midnight. Covered: the oldest object leaving a rolling
 * "after" window (`now-7d`), and the next bucket or midnight for `today` bounds and
 * time buckets. Not covered: objects entering through a moving "before" bound.
 */
export function buildNextChangeSql(workspaceId: string, spec: DataQuerySpec): SqlFragment {
	const filters = spec.filters ?? {}
	const { from, where, tz } = fromAndWhere(workspaceId, spec)
	const candidates: SqlFragment[] = []

	// A row leaves "created_after: now-7d" at its own created_at + 7d.
	for (const [column, value] of [
		[sql`o.created_at`, filters.created_after],
		[sql`o.updated_at`, filters.updated_after],
	] as const) {
		const rel = value ? parseRelativeBound(value) : null
		if (rel?.base === 'now' && rel.amount > 0) {
			candidates.push(
				sql`(SELECT min(${column}) FROM ${from} WHERE ${sql.join(where, sql` AND `)}) + ${intervalSql(rel)}`,
			)
		}
	}

	const bucket = timeBucket(spec.group_by)
	const usesToday = Object.values(filters).some(
		(v) => typeof v === 'string' && parseRelativeBound(v)?.base === 'today',
	)
	if (bucket?.unit === 'hour') {
		candidates.push(
			sql`((date_trunc('hour', now() AT TIME ZONE ${tz}) + interval '1 hour') AT TIME ZONE ${tz})`,
		)
	} else if (bucket || usesToday) {
		// A day, week or month bucket, or a "today" bound, next moves at midnight. Checking at
		// every midnight is a harmless superset of the week and month boundaries.
		candidates.push(
			sql`((date_trunc('day', now() AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz})`,
		)
	}

	// Milliseconds from the database's own clock, so a browser clock that is off cannot
	// make the caller wake too early.
	if (candidates.length === 0) return sql`SELECT NULL::bigint AS in_ms`
	return sql`SELECT (extract(epoch FROM (LEAST(${sql.join(candidates, sql`, `)}) - now())) * 1000)::bigint AS in_ms`
}

/**
 * One grouped aggregation over `objects`, built so the whole query runs in Postgres and one
 * row per group comes back. Every caller-supplied value (type, status, metadata field names
 * and values, dates, loop id) is a bound parameter; field names are already restricted to
 * SAFE_METADATA_FIELD_NAME_RE by the spec schema and are still never spliced into the SQL text.
 *
 * Nothing is capped here: not the rows scanned, not the groups returned. What bounds the work
 * is the statement timeout `runDataQuery` sets, and what bounds a response is paging.
 */
export function buildDataQuerySql(workspaceId: string, spec: DataQuerySpec): SqlFragment {
	const op = spec.aggregate?.op ?? 'count'
	const aggField = spec.aggregate?.field
	const { from, where, tz } = fromAndWhere(workspaceId, spec)

	let keyExpr: SqlFragment = sql`NULL::text`
	if (spec.group_by === 'status') keyExpr = sql`o.status`
	else if (spec.group_by === 'type') keyExpr = sql`o.type`
	else if (spec.group_by?.startsWith('metadata.')) {
		keyExpr = sql`o.metadata ->> ${spec.group_by.slice('metadata.'.length)}::text`
	} else if (timeBucket(spec.group_by)) {
		const { column, unit } = timeBucket(spec.group_by) as TimeBucket
		const col = column === 'created_at' ? sql`o.created_at` : sql`o.updated_at`
		keyExpr = sql`to_char(date_trunc(${unit}, ${col} AT TIME ZONE ${tz}), ${BUCKET_KEY_FORMAT[unit]})`
	}
	// Time buckets run oldest first; everything else puts the biggest groups first.
	const groupOrder = timeBucket(spec.group_by) ? sql`g.k ASC` : sql`g.n DESC, g.k ASC NULLS LAST`

	// Only real JSON numbers count: a field holding "abc" or null contributes
	// nothing instead of failing the cast for the whole query.
	const valueExpr: SqlFragment =
		op === 'count' || !aggField
			? sql`NULL::numeric`
			: sql`CASE WHEN jsonb_typeof(o.metadata -> ${aggField}::text) = 'number'
				THEN (o.metadata ->> ${aggField}::text)::numeric END`

	// Grouped by output position: the key expression carries bound parameters, and Postgres
	// cannot tell two placeholders for the same value apart.
	return sql`
		WITH grouped AS (
			SELECT ${keyExpr} AS k, count(*) AS n, sum(${valueExpr}) AS s, count(${valueExpr}) AS nv
			FROM ${from}
			WHERE ${sql.join(where, sql` AND `)}
			GROUP BY 1
		)
		SELECT g.k AS key, g.n, g.s, g.nv,
			sum(g.n) OVER () AS total_n,
			sum(g.s) OVER () AS total_s,
			sum(g.nv) OVER () AS total_nv
		FROM grouped g
		ORDER BY ${groupOrder}
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
}

function valueFor(op: 'count' | 'sum' | 'avg', n: number, s: number | null, nv: number) {
	if (op === 'count') return n
	if (s === null || nv === 0) return null
	return op === 'sum' ? s : s / nv
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

/**
 * Turns the grouped rows into the whole answer: every group, no cursor. No rows means nothing
 * matched. `pageOfResult` cuts it into the pages a caller actually receives.
 */
export function shapeDataQueryResult(rows: DataQueryRow[], spec: DataQuerySpec): DataQueryResult {
	const op = spec.aggregate?.op ?? 'count'
	const first = rows[0]
	if (!first) {
		return {
			groups: [],
			total: { count: 0, value: op === 'count' ? 0 : null },
			next_cursor: null,
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
		next_cursor: null,
		rows_truncated: false,
		groups_truncated: false,
	}
}

/** A cursor is `<snapshot id>.<offset>`: where the next page starts in that snapshot. */
const CURSOR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,9})$/

export function parseCursor(cursor: string): { snapshotId: string; offset: number } | null {
	const m = CURSOR_RE.exec(cursor)
	return m ? { snapshotId: m[1] as string, offset: Number(m[2]) } : null
}

/**
 * One page of a whole answer. `snapshotId` names where the rest can be read; it is only used
 * when groups remain after this page. The totals always describe every group, not the page.
 */
export function pageOfResult(
	full: DataQueryResult,
	offset: number,
	limit: number,
	snapshotId: string | null,
): DataQueryResult {
	const end = offset + limit
	const more = end < full.groups.length && snapshotId !== null
	return {
		...full,
		groups: full.groups.slice(offset, end),
		next_cursor: more ? `${snapshotId}.${end}` : null,
		groups_truncated: more,
	}
}

const querySchema = z.object({
	spec: z.string().min(2).max(4000).openapi({
		description:
			'JSON-encoded query: { scope, type, filters, group_by, aggregate }. See the query_data MCP tool.',
	}),
})

const dataQueryParamsSchema = querySchema.extend({
	cursor: z.string().max(80).optional().openapi({
		description: "The previous page's `next_cursor`, to read the next page of groups.",
	}),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(DATA_QUERY_MAX_PAGE_SIZE)
		.optional()
		.openapi({
			description: `Groups per page (default ${DATA_QUERY_PAGE_SIZE}, at most ${DATA_QUERY_MAX_PAGE_SIZE}).`,
		}),
})

/** Longest one query may run. Below the role-level timeout, and set here so a self-hosted DB has one too. */
const DATA_QUERY_TIMEOUT_MS = 15_000

/** Runs the aggregation under its own statement timeout and shapes the whole answer. */
async function runDataQuery(
	db: Database,
	workspaceId: string,
	spec: DataQuerySpec,
): Promise<DataQueryResult> {
	const rows = await db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(DATA_QUERY_TIMEOUT_MS))}`)
		return Array.from(await tx.execute<DataQueryRow>(buildDataQuerySql(workspaceId, spec)))
	})
	return shapeDataQueryResult(rows, spec)
}

const dataQueryRoute = createRoute({
	method: 'get',
	path: '/query',
	tags: ['data'],
	summary: 'Read-only grouped aggregation over objects',
	description:
		'Counts, sums or averages objects of one type, optionally grouped by status, type or a metadata field and scoped to the workspace or one loop. Aggregation runs in the database over every matching object. Groups come back a page at a time: while `next_cursor` is set, pass it back as `cursor` to read the next page. Totals always cover every group.',
	request: { headers: workspaceIdHeader, query: dataQueryParamsSchema },
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

/**
 * Custom loop views fire a burst of these, and the database pool is shared with everything else
 * (auth on every request, session logs, triggers). Left unbounded, one view held every
 * connection and the whole server stopped answering. Only this many run at once; the rest wait.
 */
const MAX_CONCURRENT_DATA_QUERIES = 3
let activeDataQueries = 0
const waitingDataQueries: Array<() => void> = []

async function withDataQuerySlot<T>(work: () => Promise<T>): Promise<T> {
	if (activeDataQueries >= MAX_CONCURRENT_DATA_QUERIES) {
		await new Promise<void>((resolve) => waitingDataQueries.push(resolve))
	}
	activeDataQueries += 1
	try {
		return await work()
	} finally {
		activeDataQueries -= 1
		waitingDataQueries.shift()?.()
	}
}

type SpecOutcome =
	| { spec: DataQuerySpec }
	| { status: 400 | 404; error: ReturnType<typeof createApiError> }

/** Parses the `spec` query param. No database involved. */
function parseSpec(rawSpec: string): SpecOutcome {
	let json: unknown
	try {
		json = JSON.parse(rawSpec)
	} catch {
		return { status: 400, error: createApiError('VALIDATION_ERROR', 'spec must be valid JSON') }
	}
	const parsed = dataQuerySpecSchema.safeParse(json)
	if (!parsed.success) {
		return {
			status: 400,
			error: createApiError('VALIDATION_ERROR', 'Invalid query', formatZodError(parsed.error)),
		}
	}
	return { spec: parsed.data }
}

/** Parses the `spec` query param and checks a loop scope belongs to the workspace. */
async function readSpec(db: Database, workspaceId: string, rawSpec: string): Promise<SpecOutcome> {
	const outcome = parseSpec(rawSpec)
	if ('error' in outcome) return outcome
	const { spec } = outcome

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
		if (!loop) return { status: 404, error: createApiError('NOT_FOUND', 'Loop not found') }
	}
	return { spec }
}

app.openapi(dataQueryRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { spec: rawSpec, cursor: rawCursor, limit = DATA_QUERY_PAGE_SIZE } = c.req.valid('query')

	const cursor = rawCursor === undefined ? null : parseCursor(rawCursor)
	if (rawCursor !== undefined && !cursor) {
		return c.json(createApiError('VALIDATION_ERROR', 'cursor is not a valid page cursor'), 400)
	}

	const parsed = parseSpec(rawSpec)
	if ('error' in parsed) return c.json(parsed.error, parsed.status)
	const specKey = JSON.stringify(parsed.spec)

	// A later page is cut from the snapshot the first page left behind: no query, no pool slot.
	const held = cursor ? readSnapshot(cursor.snapshotId, workspaceId, specKey) : null
	if (cursor && held) {
		return c.json(pageOfResult(held, cursor.offset, limit, cursor.snapshotId), 200)
	}

	return withDataQuerySlot(async () => {
		const outcome = await readSpec(db, workspaceId, rawSpec)
		if ('error' in outcome) return c.json(outcome.error, outcome.status)

		const full = await runDataQuery(db, workspaceId, outcome.spec)
		const offset = cursor?.offset ?? 0
		// Only worth keeping when groups remain after this page.
		const snapshotId =
			offset + limit < full.groups.length ? saveSnapshot(workspaceId, specKey, full) : null
		return c.json(pageOfResult(full, offset, limit, snapshotId), 200)
	})
}) as RouteHandler<typeof dataQueryRoute, Env>)

const nextChangeResultSchema = z.object({
	in_ms: z.number().int().nonnegative().nullable(),
})

const nextChangeRoute = createRoute({
	method: 'get',
	path: '/next-change',
	tags: ['data'],
	summary: 'When a query next changes through time alone',
	description:
		'For the loop page: the next moment the answer to a query changes with no write (an object ageing out of a rolling window, or a day or hour rolling over), or null. Not part of the agent tools.',
	request: { headers: workspaceIdHeader, query: querySchema },
	responses: {
		200: {
			description: 'The next time-driven change',
			content: { 'application/json': { schema: nextChangeResultSchema } },
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

app.openapi(nextChangeRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { spec: rawSpec } = c.req.valid('query')

	return withDataQuerySlot(async () => {
		const outcome = await readSpec(db, workspaceId, rawSpec)
		if ('error' in outcome) return c.json(outcome.error, outcome.status)

		const rows = await db.execute<{ in_ms: number | string | null }>(
			buildNextChangeSql(workspaceId, outcome.spec),
		)
		const ms = Array.from(rows)[0]?.in_ms
		return c.json({ in_ms: ms === null || ms === undefined ? null : Math.max(0, Number(ms)) }, 200)
	})
}) as RouteHandler<typeof nextChangeRoute, Env>)

export default app
