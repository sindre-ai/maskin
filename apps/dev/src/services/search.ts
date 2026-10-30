import type { Database } from '@maskin/db'
import {
	SEARCH_SOURCE_GROUPS,
	STATUS_GROUP_KEYS,
	type SearchQuery,
	type SearchResponse,
	type SearchResultRow,
	type SearchSourceGroup,
	type StatusGroupKey,
	getStatusGroup,
} from '@maskin/shared'
import { type SQL, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { TITLE_COVERAGE_SCALE, TITLE_HIT_WEIGHT, tokenIlikePattern } from '../lib/search-rank'
import { canHaveTypo, titleTypoDistance } from '../lib/search-typo'

/** A source that takes longer than this is reported as partial instead of failing the request. */
const SOURCE_TIMEOUT_MS = 5000
const MAX_TOKENS = 8
/** Safety bound on the counted rows (types x statuses x window flag, so tiny in practice). */
const MAX_AGGREGATE_ROWS = 5000
/** The hidden-by-default status, same literal as the objects routes. */
const ARCHIVED = 'archived'
/** The typo pass runs only when the strict search returned fewer rows than this (or the limit). */
const TYPO_PASS_BELOW = 5
/** Most rows a source loads for the typo pass. A source with more is reported as partial. */
const TYPO_CANDIDATE_CAP = 5000

export interface SearchContext {
	workspaceId: string
	callerId: string
}

/**
 * One searchable source. `candidates` is a SELECT with scope applied but no text
 * match, returning exactly these columns: id, type, title, sub, body, status,
 * updated_at. Text match, ranking, counting and paging are generic and live in
 * runSource, so a source only says where its rows come from and which (type, status)
 * pairs it can hold.
 *
 * Correlated subqueries use literal table-qualified SQL, never Drizzle column
 * objects (known-pitfalls.md, the correlated-subquery entry).
 */
export interface SearchSource {
	key: SearchSourceGroup
	candidates: (ctx: SearchContext) => SQL
	/** Type keys that always appear in facets.types, zero count included. */
	fixedTypes: string[]
	/**
	 * Every (type, status) pair the source holds, whatever the text. Cheap (an
	 * index or a constant list), and it lets the filters be settled before the one
	 * text scan: it also gives facets.types its zero-count keys.
	 */
	statusPairs: (ctx: SearchContext) => SQL
	/**
	 * A boolean over a candidate row (aliased `s`): true when the row passes the
	 * participants filter. A source without it never passes once a participant is
	 * picked. It is a flag, not a WHERE, so the relaxed counts can still ignore it.
	 */
	participantsOk?: (participants: string[]) => SQL
	/**
	 * The rows have no status of their own (people). Any status filter hides them,
	 * and they stay out of the status counts, so a chip never counts rows that
	 * disappear when it is picked.
	 */
	statusless?: boolean
}

export const SEARCH_SOURCES: SearchSource[] = [
	{
		key: 'chats',
		fixedTypes: ['chat'],
		statusPairs: () => sql`
			SELECT 'chat'::text AS type, v.status AS status
			FROM (VALUES ('archived'), ('unread'), ('read')) AS v(status)`,
		candidates: ({ workspaceId, callerId }) => sql`
			SELECT c.id AS id,
				'chat'::text AS type,
				c.title AS title,
				(SELECT string_agg(a.name, ', ' ORDER BY a.name)
					FROM conversation_participants cp2
					INNER JOIN actors a ON a.id = cp2.actor_id
					WHERE cp2.conversation_id = c.id AND cp2.left_at IS NULL) AS sub,
				lm.content AS body,
				CASE
					WHEN cp.archived THEN 'archived'
					WHEN EXISTS (
						SELECT 1 FROM messages m
						WHERE m.conversation_id = c.id
							AND m.actor_id <> ${callerId}
							AND m.id > COALESCE(cp.last_read_message_id, 0)
					) THEN 'unread'
					ELSE 'read'
				END AS status,
				c.last_message_at AS updated_at
			FROM conversations c
			INNER JOIN conversation_participants cp
				ON cp.conversation_id = c.id AND cp.actor_id = ${callerId} AND cp.left_at IS NULL
			LEFT JOIN LATERAL (
				SELECT m.content FROM messages m
				WHERE m.conversation_id = c.id
				ORDER BY m.id DESC
				LIMIT 1
			) lm ON true
			WHERE c.workspace_id = ${workspaceId}`,
		// The chat must hold every picked actor (still a member, not left).
		participantsOk: (participants) =>
			sql.join(
				participants.map(
					(actorId) => sql`EXISTS (
						SELECT 1 FROM conversation_participants cpf
						WHERE cpf.conversation_id = s.id AND cpf.actor_id = ${actorId} AND cpf.left_at IS NULL
					)`,
				),
				sql` AND `,
			),
	},
	{
		key: 'loops',
		fixedTypes: ['loop'],
		statusPairs: ({ workspaceId }) => sql`
			SELECT DISTINCT o.type AS type, o.status AS status FROM objects o
			WHERE o.workspace_id = ${workspaceId} AND o.type = 'loop'`,
		candidates: ({ workspaceId }) => sql`
			SELECT o.id AS id, o.type AS type, COALESCE(o.title, '') AS title, NULL::text AS sub,
				o.content AS body, o.status AS status, o.updated_at AS updated_at
			FROM objects o
			WHERE o.workspace_id = ${workspaceId} AND o.type = 'loop'`,
	},
	{
		key: 'agents',
		fixedTypes: ['agent'],
		statusPairs: ({ workspaceId }) => sql`
			SELECT DISTINCT 'agent'::text AS type, a.agent_state AS status FROM actors a
			INNER JOIN workspace_members wm ON wm.actor_id = a.id AND wm.workspace_id = ${workspaceId}
			WHERE a.type = 'agent'`,
		candidates: ({ workspaceId }) => sql`
			SELECT a.id AS id, 'agent'::text AS type, a.name AS title, NULL::text AS sub,
				a.description AS body, a.agent_state AS status,
				GREATEST(a.updated_at, a.agent_state_updated_at) AS updated_at
			FROM actors a
			INNER JOIN workspace_members wm ON wm.actor_id = a.id AND wm.workspace_id = ${workspaceId}
			WHERE a.type = 'agent'`,
	},
	{
		key: 'people',
		fixedTypes: ['person'],
		statusless: true,
		statusPairs: () => sql`SELECT 'person'::text AS type, 'member'::text AS status`,
		// The member dialog shows the name and the email, so both are searchable: the
		// email rides in the sub line, which the generic match already reads.
		candidates: ({ workspaceId }) => sql`
			SELECT a.id AS id, 'person'::text AS type, a.name AS title, a.email AS sub,
				NULL::text AS body, 'member'::text AS status, a.updated_at AS updated_at
			FROM actors a
			INNER JOIN workspace_members wm ON wm.actor_id = a.id AND wm.workspace_id = ${workspaceId}
			WHERE a.type = 'human'`,
	},
	{
		key: 'objects',
		fixedTypes: [],
		statusPairs: ({ workspaceId }) => sql`
			SELECT DISTINCT o.type AS type, o.status AS status FROM objects o
			WHERE o.workspace_id = ${workspaceId} AND o.type <> 'loop'`,
		candidates: ({ workspaceId }) => sql`
			SELECT o.id AS id, o.type AS type, COALESCE(o.title, '') AS title, NULL::text AS sub,
				o.content AS body, o.status AS status, o.updated_at AS updated_at
			FROM objects o
			WHERE o.workspace_id = ${workspaceId} AND o.type <> 'loop'`,
	},
	{
		key: 'automations',
		fixedTypes: ['automation'],
		statusPairs: () => sql`
			SELECT 'automation'::text AS type, v.status AS status
			FROM (VALUES ('on'), ('off')) AS v(status)`,
		candidates: ({ workspaceId }) => sql`
			SELECT t.id AS id, 'automation'::text AS type, t.name AS title, t.type AS sub,
				t.action_prompt AS body,
				CASE WHEN t.enabled THEN 'on' ELSE 'off' END AS status,
				t.updated_at AS updated_at
			FROM triggers t
			WHERE t.workspace_id = ${workspaceId}`,
	},
]

/** Lower-cased distinct words, at most MAX_TOKENS. No stopwords and no minimum length. */
export function searchTokens(q: string | undefined): string[] {
	if (!q) return []
	const words = q.toLowerCase().split(/\s+/).filter(Boolean)
	return [...new Set(words)].slice(0, MAX_TOKENS)
}
/** Hit-flag column names. The index comes from our own loop over the words, never from input. */
const flag = (kind: 't' | 'b' | 'u', i: number) => sql.raw(`${kind}${i}`)

/**
 * Per word, three flags computed once per row: a hit in the title, the body, the
 * sub line. The match (every word hits somewhere) and the score both read the
 * flags, so the text is scanned a single time.
 */
function flagColumns(tokens: string[]): SQL {
	const perToken = tokens.map((token, i) => {
		const pattern = tokenIlikePattern(token)
		return sql`, (s.title ilike ${pattern}) AS ${flag('t', i)}, (s.body ilike ${pattern}) AS ${flag('b', i)}, (s.sub ilike ${pattern}) AS ${flag('u', i)}`
	})
	return sql.join(perToken, sql``)
}

/** Every word must hit the title, the body or the sub line (AND across words). */
function matchCondition(tokens: string[]): SQL {
	if (tokens.length === 0) return sql`true`
	const perToken = tokens.map(
		(_, i) => sql`(x.${flag('t', i)} or x.${flag('b', i)} or x.${flag('u', i)})`,
	)
	return sql.join(perToken, sql` and `)
}

/** Same per-word formula as /api/objects/search: title hit plus coverage, body hit worth 1. */
function scoreExpression(tokens: string[]): SQL {
	if (tokens.length === 0) return sql`0`
	const perToken = tokens.map(
		(token, i) =>
			sql`((case when x.${flag('t', i)} then ${TITLE_HIT_WEIGHT}::int + floor(${TITLE_COVERAGE_SCALE}::int * ${token.length}::int / greatest(length(x.title), 1)) else 0 end) + (case when x.${flag('b', i)} then 1 else 0 end))`,
	)
	return sql.join(perToken, sql` + `)
}

function orderBy(sort: SearchQuery['sort']): SQL {
	if (sort === 'recent') return sql`m.updated_at desc nulls last, m.id`
	if (sort === 'az') return sql`lower(m.title) asc, m.id`
	return sql`m.score desc, m.updated_at desc nulls last, m.id`
}

interface PairRow {
	type: string
	status: string
}

interface AggregateRow {
	type: string
	status: string
	in_window: boolean
	/** False when the row misses the participants filter; always true with none picked. */
	p_ok: boolean
	n: number
}

interface RawRow {
	id: string
	type: string
	title: string
	sub: string | null
	snippet: string | null
	status: string
	updated_iso: string | null
}

interface SourceResult {
	rows: SearchResultRow[]
	/** Matches after every filter, before the cap. */
	total: number
	/** Text match only, minus the archive rule. */
	typeCounts: Map<string, number>
	/** Text match plus selected types, archive rule lifted. */
	statusCounts: Record<StatusGroupKey, number>
	/** Text match with every filter dropped (archive rule kept). */
	withoutFilters: number
	/** Text match plus selected types and participants (archive rule kept). */
	withoutStatuses: number
	knownTypes: string[]
	/** Title hits with a typo, found by the second pass. Empty when it did not run. */
	typoRows: TypoRow[]
}

interface TypoRow {
	row: SearchResultRow
	/** Typos in the title, fewest first. */
	distance: number
}

type Executor = Pick<Database, 'execute'>

async function rowsOf<T>(executor: Executor, query: SQL): Promise<T[]> {
	return (await executor.execute(query)) as unknown as T[]
}

/** A json column arrives parsed or as text depending on the driver settings. */
function jsonRows<T>(value: unknown): T[] {
	if (typeof value === 'string') return JSON.parse(value) as T[]
	return Array.isArray(value) ? (value as T[]) : []
}

function emptyStatusCounts(): Record<StatusGroupKey, number> {
	return { needs_you: 0, in_progress: 0, new: 0, done: 0, archived: 0 }
}

/** The type, status, archive and window rules of a query, as the checks every row goes through. */
function filterRules(query: SearchQuery, source: SearchSource) {
	const typeFilter = new Set(query.types ?? [])
	const statusFilter = new Set<StatusGroupKey>(query.statuses ?? [])
	const cutoff = query.updated_after ? new Date(query.updated_after).toISOString() : null
	const archivedVisible = statusFilter.has('archived')
	return {
		cutoff,
		archivedHidden: (status: string) => status === ARCHIVED && !archivedVisible,
		typeOk: (type: string) => typeFilter.size === 0 || typeFilter.has(type),
		statusOk: (group: StatusGroupKey) =>
			statusFilter.size === 0 || (!source.statusless && statusFilter.has(group)),
		statusless: source.statusless === true,
	}
}

type FilterRules = ReturnType<typeof filterRules>

/** True for a candidate row (aliased `s`) that passes the participants filter; true for all with none picked. */
function participantsCondition(query: SearchQuery, source: SearchSource): SQL {
	const participants = query.participants ?? []
	if (participants.length === 0) return sql`true`
	// With a participant picked, a source that cannot filter by one never matches.
	return source.participantsOk ? source.participantsOk(participants) : sql`false`
}

/** Adds `n` rows of one (type, status, window) cell to the counts of a source. */
function tally(
	result: SourceResult,
	rules: FilterRules,
	row: { type: string; status: string; in_window: boolean; p_ok: boolean; n: number },
) {
	const { archivedHidden, typeOk, statusOk, cutoff, statusless } = rules
	const group = getStatusGroup(row.type, row.status)
	const hidden = archivedHidden(row.status)

	// The "search everything" count ignores the participants along with every other filter.
	if (row.status !== ARCHIVED) result.withoutFilters += row.n
	if (!row.p_ok) return

	if (!hidden) result.typeCounts.set(row.type, (result.typeCounts.get(row.type) ?? 0) + row.n)
	if (typeOk(row.type) && !statusless) result.statusCounts[group] += row.n
	if (row.status !== ARCHIVED && typeOk(row.type)) result.withoutStatuses += row.n
	if (!hidden && typeOk(row.type) && statusOk(group) && (!cutoff || row.in_window)) {
		result.total += row.n
	}
}

async function runSource(
	executor: Executor,
	source: SearchSource,
	ctx: SearchContext,
	query: SearchQuery,
	tokens: string[],
): Promise<SourceResult> {
	const rules = filterRules(query, source)
	const { archivedHidden, typeOk, statusOk, cutoff } = rules

	// Settle the type and status filters first, from the (type, status) pairs the
	// source holds. That is cheap, and it means the one text scan below can both
	// count everything and pick the rows to return.
	const pairs = await rowsOf<PairRow>(executor, source.statusPairs(ctx))
	const knownTypes = [...source.fixedTypes]
	const passingPairs: PairRow[] = []
	for (const pair of pairs) {
		if (!knownTypes.includes(pair.type)) knownTypes.push(pair.type)
		if (
			!archivedHidden(pair.status) &&
			typeOk(pair.type) &&
			statusOk(getStatusGroup(pair.type, pair.status))
		) {
			passingPairs.push(pair)
		}
	}

	const match = matchCondition(tokens)
	const participantsOk = participantsCondition(query, source)
	const inWindow = cutoff ? sql`coalesce(x.updated_at > ${cutoff}::timestamptz, false)` : sql`true`
	const pairList = sql.join(
		passingPairs.map(({ type, status }) => sql`(${type}::text, ${status}::text)`),
		sql`, `,
	)
	const topFilter =
		passingPairs.length === 0
			? sql`false`
			: sql`(m.type, m.status) IN (${pairList}) AND m.in_window AND m.p_ok`
	const ordering = orderBy(query.sort)

	// One scan. x computes the per-word hit flags once per row (OFFSET 0 keeps the
	// planner from folding them back into the filter), m keeps the matches, and
	// both the counts and the top rows read m.
	const [raw] = await rowsOf<{ aggregate: unknown; top_rows: unknown }>(
		executor,
		sql`WITH x AS (
				SELECT s.id, s.type, s.title, s.sub, left(s.body, 160) AS snippet, s.status, s.updated_at,
					(${participantsOk}) AS p_ok
					${flagColumns(tokens)}
				FROM (${source.candidates(ctx)}) s
				OFFSET 0
			),
			m AS (
				SELECT x.id, x.type, x.title, x.sub, x.snippet, x.status, x.updated_at, x.p_ok,
					${scoreExpression(tokens)} AS score,
					${inWindow} AS in_window
				FROM x
				WHERE ${match}
			),
			counted AS (
				SELECT m.type, m.status, m.in_window, m.p_ok, count(*)::int AS n
				FROM m GROUP BY 1, 2, 3, 4 LIMIT ${MAX_AGGREGATE_ROWS}
			),
			picked AS (
				SELECT m.id, m.type, m.title, m.sub, m.snippet, m.status,
					to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_iso,
					row_number() OVER (ORDER BY ${ordering}) AS rn
				FROM m
				WHERE ${topFilter}
				ORDER BY ${ordering}
				LIMIT ${query.limit}
			)
			SELECT (SELECT coalesce(json_agg(counted), '[]'::json) FROM counted) AS aggregate,
				(SELECT coalesce(json_agg(picked ORDER BY picked.rn), '[]'::json) FROM picked) AS top_rows`,
	)

	const result: SourceResult = {
		rows: [],
		total: 0,
		typeCounts: new Map(),
		statusCounts: emptyStatusCounts(),
		withoutFilters: 0,
		withoutStatuses: 0,
		knownTypes,
		typoRows: [],
	}

	for (const row of jsonRows<AggregateRow>(raw?.aggregate)) tally(result, rules, row)

	result.rows = jsonRows<RawRow>(raw?.top_rows).map((row) => ({
		id: row.id,
		group: source.key,
		type: row.type,
		title: row.title,
		sub: row.sub,
		snippet: row.snippet ? row.snippet : null,
		status: row.status,
		statusGroup: getStatusGroup(row.type, row.status),
		updatedAt: row.updated_iso,
	}))
	return result
}

/** Each source runs in its own transaction so the statement timeout is scoped to it. */
async function runSourceWithTimeout(
	db: Database,
	source: SearchSource,
	ctx: SearchContext,
	query: SearchQuery,
	tokens: string[],
): Promise<SourceResult> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(SOURCE_TIMEOUT_MS))}`)
		return runSource(tx, source, ctx, query, tokens)
	})
}

/**
 * Second pass for a query the strict search answered with few rows. Loads the newest
 * TYPO_CANDIDATE_CAP titles of the source and keeps the ones where every word is found in the
 * title with a typo or two ("mgnus" finds "Magnus"). Names and titles only, never the body.
 * A hit the strict pass already counted (its words sit in the title, body or sub line) is
 * dropped, so nothing is counted twice. The hits join the counts and facets through the same
 * tally as the strict rows. Returns true when the source holds more than the cap, so some
 * titles were not looked at.
 */
async function runTypoPass(
	db: Database,
	source: SearchSource,
	ctx: SearchContext,
	query: SearchQuery,
	tokens: string[],
	result: SourceResult,
): Promise<boolean> {
	const rules = filterRules(query, source)
	const { truncated, hits } = await db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(SOURCE_TIMEOUT_MS))}`)
		const candidates = await rowsOf<RawRow & { p_ok: boolean }>(
			tx,
			sql`SELECT s.id, s.type, s.title, s.sub, left(s.body, 160) AS snippet, s.status,
					to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_iso,
					(${participantsCondition(query, source)}) AS p_ok
				FROM (${source.candidates(ctx)}) s
				WHERE s.title <> ''
				ORDER BY s.updated_at DESC NULLS LAST, s.id
				LIMIT ${TYPO_CANDIDATE_CAP + 1}`,
		)
		const fuzzy: Array<{ raw: RawRow & { p_ok: boolean }; distance: number }> = []
		for (const raw of candidates.slice(0, TYPO_CANDIDATE_CAP)) {
			const distance = titleTypoDistance(tokens, raw.title)
			if (distance !== null) fuzzy.push({ raw, distance })
		}

		// Which of the title hits did the strict pass already count? Asked for those rows only.
		const strict = new Set<string>()
		if (fuzzy.length > 0) {
			const ids = sql.join(
				fuzzy.map(({ raw }) => sql`${raw.id}`),
				sql`, `,
			)
			const matched = await rowsOf<{ id: string }>(
				tx,
				sql`WITH x AS (
						SELECT s.id ${flagColumns(tokens)}
						FROM (${source.candidates(ctx)}) s
						WHERE s.id IN (${ids})
					)
					SELECT x.id FROM x WHERE ${matchCondition(tokens)}`,
			)
			for (const row of matched) strict.add(row.id)
		}
		return {
			truncated: candidates.length > TYPO_CANDIDATE_CAP,
			hits: fuzzy.filter(({ raw }) => !strict.has(raw.id)),
		}
	})

	for (const { raw, distance } of hits) {
		const inWindow = rules.cutoff
			? raw.updated_iso !== null && new Date(raw.updated_iso) > new Date(rules.cutoff)
			: true
		tally(result, rules, {
			type: raw.type,
			status: raw.status,
			in_window: inWindow,
			p_ok: raw.p_ok,
			n: 1,
		})
		const group = getStatusGroup(raw.type, raw.status)
		if (
			!raw.p_ok ||
			rules.archivedHidden(raw.status) ||
			!rules.typeOk(raw.type) ||
			!rules.statusOk(group) ||
			!inWindow
		) {
			continue
		}
		result.typoRows.push({
			distance,
			row: {
				id: raw.id,
				group: source.key,
				type: raw.type,
				title: raw.title,
				sub: raw.sub,
				snippet: raw.snippet ? raw.snippet : null,
				status: raw.status,
				statusGroup: group,
				updatedAt: raw.updated_iso,
			},
		})
	}
	return truncated
}

function compareRows(sort: 'recent' | 'az') {
	return (a: SearchResultRow, b: SearchResultRow): number => {
		if (sort === 'az') {
			const byTitle = a.title.localeCompare(b.title, undefined, {
				sensitivity: 'base',
				numeric: true,
			})
			if (byTitle !== 0) return byTitle
		} else if (a.updatedAt !== b.updatedAt) {
			if (a.updatedAt === null) return 1
			if (b.updatedAt === null) return -1
			return a.updatedAt < b.updatedAt ? 1 : -1
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	}
}

/**
 * Runs the typo pass on every answered source when the strict search found few rows, and adds
 * the hits to each source's result. A source whose pass fails or hits the candidate cap is
 * listed in `partial`; its strict answer stays.
 */
async function addTypoHits(
	db: Database,
	ctx: SearchContext,
	query: SearchQuery,
	tokens: string[],
	ok: Array<{ source: SearchSource; result: SourceResult }>,
	partial: SearchSourceGroup[],
) {
	if (!tokens.some(canHaveTypo)) return
	// Below this many strict rows (and below the limit, so every strict row was returned).
	const strictRows = ok.reduce((sum, { result }) => sum + result.total, 0)
	if (strictRows >= Math.min(TYPO_PASS_BELOW, query.limit)) return

	const startedAt = Date.now()
	const outcomes = await Promise.allSettled(
		ok.map(({ source, result }) => runTypoPass(db, source, ctx, query, tokens, result)),
	)
	logger.info('Search typo pass', {
		workspaceId: ctx.workspaceId,
		durationMs: Date.now() - startedAt,
		strictRows,
		typoRows: ok.reduce((sum, { result }) => sum + result.typoRows.length, 0),
	})
	outcomes.forEach((outcome, i) => {
		const source = (ok[i] as (typeof ok)[number]).source
		if (outcome.status === 'fulfilled') {
			if (outcome.value) partial.push(source.key)
			return
		}
		partial.push(source.key)
		logger.warn('Search typo pass failed', {
			source: source.key,
			workspaceId: ctx.workspaceId,
			error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
		})
	})
}

/**
 * Runs the six sources in parallel and folds them into one response. A source
 * that throws or times out is left out of every count and listed in `partial`.
 * `sources` is a parameter so a test can swap in a failing one.
 */
export async function runSearch(
	db: Database,
	ctx: SearchContext,
	query: SearchQuery,
	sources: SearchSource[] = SEARCH_SOURCES,
): Promise<SearchResponse> {
	const tokens = searchTokens(query.q)
	const settled = await Promise.allSettled(
		sources.map((source) => runSourceWithTimeout(db, source, ctx, query, tokens)),
	)

	const partial: SearchSourceGroup[] = []
	const ok: Array<{ source: SearchSource; result: SourceResult }> = []
	settled.forEach((outcome, i) => {
		const source = sources[i] as SearchSource
		if (outcome.status === 'fulfilled') {
			ok.push({ source, result: outcome.value })
			return
		}
		partial.push(source.key)
		logger.warn('Search source failed', {
			source: source.key,
			workspaceId: ctx.workspaceId,
			error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
		})
	})

	await addTypoHits(db, ctx, query, tokens, ok, partial)

	const typeFacets: Record<string, number> = {}
	const statusFacets = emptyStatusCounts()
	let total = 0
	let withoutFilters = 0
	let withoutStatuses = 0
	for (const { result } of ok) {
		for (const type of result.knownTypes) typeFacets[type] ??= 0
		for (const [type, n] of result.typeCounts) typeFacets[type] = (typeFacets[type] ?? 0) + n
		for (const key of STATUS_GROUP_KEYS) statusFacets[key] += result.statusCounts[key]
		total += result.total
		withoutFilters += result.withoutFilters
		withoutStatuses += result.withoutStatuses
	}

	let results: SearchResultRow[]
	if (query.sort === 'rel') {
		// Groups in a fixed order, then each source's own relevance order, until the cap.
		const order = (key: SearchSourceGroup) => SEARCH_SOURCE_GROUPS.indexOf(key)
		const byGroup = ok.slice().sort((a, b) => order(a.source.key) - order(b.source.key))
		// Typo hits come after every exact hit, closest spelling first.
		const typoRows = byGroup
			.flatMap(({ result }) => result.typoRows)
			.sort((a, b) => a.distance - b.distance)
			.map(({ row }) => row)
		results = [...byGroup.flatMap(({ result }) => result.rows), ...typoRows].slice(0, query.limit)
	} else {
		// The top N of a union is inside the union of each source's top N.
		const sort = query.sort
		const sorted = (rows: SearchResultRow[]) => rows.sort(compareRows(sort))
		results = [
			...sorted(ok.flatMap(({ result }) => result.rows)),
			...sorted(ok.flatMap(({ result }) => result.typoRows.map(({ row }) => row))),
		].slice(0, query.limit)
	}

	return {
		results,
		total,
		capped: total > results.length,
		facets: { types: typeFacets, statuses: statusFacets },
		relaxed: { withoutFilters, withoutStatuses },
		partial,
	}
}
