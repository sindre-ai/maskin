import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { type SQL, and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'

// Column-aware retrieval for `type='knowledge'` objects. Reads/filters/ranks
// directly off `objects.metadata` — knowledge rows are ordinary `objects` rows,
// no side table. The fields this cares about (`t_valid`, `t_invalid`,
// `verification_status`, `confidence`) are just metadata keys, same storage
// as every other type's custom fields.
//
//  - bi-temporal live-only: rows with a `t_invalid` key are excluded, and rows
//    scheduled for a future validity (`t_valid > now`) are excluded so the
//    candidate set reflects what is in-force right now.
//  - `verification_status='deprecated'` rows are excluded.
//  - order: token-score DESC (when `q` is provided) → verification priority
//    (verified > pending > unverified > contested) → confidence priority
//    (high > medium > low > NULL) → `t_valid` DESC NULLS LAST (recency
//    tiebreaker) → `created_at` DESC (objects with no `t_valid` metadata key
//    tie on all of the above, so this keeps them newest-first instead of
//    falling through to `id ASC`) → id ASC.
//
// Callers on `search_objects` / list flow through here when `type='knowledge'`
// so eval and runtime retrieval stay on one path.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'been',
	'but',
	'by',
	'can',
	'could',
	'did',
	'do',
	'does',
	'for',
	'from',
	'has',
	'have',
	'how',
	'i',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'just',
	'not',
	'of',
	'on',
	'or',
	'over',
	'past',
	'per',
	'should',
	'so',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'they',
	'this',
	'to',
	'up',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'why',
	'will',
	'with',
	'you',
	'your',
])

// Same shape T1's baseline eval used. Kept here so the runtime search path
// tokenises identically to the harness that measures accuracy.
export function tokenizeKnowledgeQuery(text: string): string[] {
	const raw = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
	const seen = new Set<string>()
	const out: string[] = []
	for (const word of raw) {
		if (word.length < 3) continue
		if (STOPWORDS.has(word)) continue
		if (seen.has(word)) continue
		seen.add(word)
		out.push(word)
	}
	return out
}

function escapeIlike(input: string): string {
	return input.replace(/[%_\\]/g, '\\$&')
}

export type RetrieveKnowledgeOptions = {
	workspaceId: string
	q?: string
	status?: string[]
	driverIds?: string[]
	ids?: string[]
	updatedBefore?: string
	updatedAfter?: string
	limit: number
	offset: number
}

export type KnowledgeRow = typeof objects.$inferSelect

const metaTInvalid = sql`(${objects.metadata}->>'t_invalid')`
const metaTValid = sql`(${objects.metadata}->>'t_valid')`
const metaVerificationStatus = sql`(${objects.metadata}->>'verification_status')`
const metaConfidence = sql`(${objects.metadata}->>'confidence')`

// `metadata` is end-user-writable via PATCH /api/objects/:id — safeMetadataSchema
// only constrains value *shape* (scalars/arrays of scalars), not content. A
// malformed `t_valid`/`t_invalid` string must not blow up the whole query with a
// Postgres cast error, so every `::timestamptz` cast is guarded by an ISO-8601
// prefix check first. Non-matching / missing values fall through to NULL, same
// as a missing column did under the old knowledge_extras join.
const ISO_DATE_PREFIX = '^\\d{4}-\\d{2}-\\d{2}'
function safeTimestamp(expr: SQL): SQL {
	return sql`(case when ${expr} ~ ${ISO_DATE_PREFIX} then (${expr})::timestamptz else null end)`
}

// Verification / confidence rank expressions used both in the ORDER BY and
// (for verification) as the deprecated-exclusion filter.
const verificationPriorityExpr = sql<number>`case ${metaVerificationStatus}
	when 'verified' then 3
	when 'pending' then 2
	when 'unverified' then 1
	when 'contested' then 0
	else 1
end`

const confidencePriorityExpr = sql<number>`case ${metaConfidence}
	when 'high' then 3
	when 'medium' then 2
	when 'low' then 1
	else 0
end`

// Bi-temporal + verification "live only" filters. Shared by every read path
// that filters on knowledge metadata — retrieveKnowledge() below, and the
// board route's grouped/paginated query in apps/dev/src/routes/objects.ts —
// so a knowledge row invalidated/deprecated/future-dated is hidden
// consistently everywhere, not just on list/search.
export function knowledgeLiveOnlyFilters(): SQL[] {
	return [
		// Bi-temporal live-only. Missing `t_invalid` key → NULL → naturally live,
		// same as a missing extras row used to be under the old LEFT JOIN.
		sql`${metaTInvalid} IS NULL`,
		// In-force at query time. Rows with a future `t_valid` are scheduled for a
		// future validity and should not be candidates yet. Missing/malformed
		// `t_valid` keeps legacy rows retrievable.
		sql`(${safeTimestamp(metaTValid)} IS NULL OR ${safeTimestamp(metaTValid)} <= now())`,
		// `deprecated` verification means the row is intentionally out of retrieval.
		// Missing key is treated as retrievable — the extension may not have
		// populated this metadata for a workspace, and we don't want to hide legacy rows.
		sql`(${metaVerificationStatus} IS NULL OR ${metaVerificationStatus} <> 'deprecated')`,
	]
}

export async function retrieveKnowledge(
	db: Database,
	opts: RetrieveKnowledgeOptions,
): Promise<KnowledgeRow[]> {
	const filters: SQL[] = [eq(objects.workspaceId, opts.workspaceId), eq(objects.type, 'knowledge')]

	filters.push(...knowledgeLiveOnlyFilters())

	if (opts.status && opts.status.length > 0) {
		if (opts.status.length === 1) filters.push(eq(objects.status, opts.status[0] as string))
		else filters.push(inArray(objects.status, opts.status))
	}

	if (opts.driverIds && opts.driverIds.length > 0) {
		const owners = opts.driverIds.filter((id) => UUID_RE.test(id))
		if (owners.length === 1) filters.push(eq(objects.driver, owners[0] as string))
		else if (owners.length > 1) filters.push(inArray(objects.driver, owners))
	}

	if (opts.ids && opts.ids.length > 0) {
		const idList = opts.ids.filter((id) => UUID_RE.test(id))
		if (idList.length > 0) filters.push(inArray(objects.id, idList))
	}

	// Half-open contract, mirroring buildObjectListConditions in objects.ts —
	// callers (e.g. the stalled-work watchdog) rely on this range filter, and
	// it must apply here too or a `type=knowledge` query silently loses it.
	if (opts.updatedBefore) filters.push(lt(objects.updatedAt, new Date(opts.updatedBefore)))
	if (opts.updatedAfter) filters.push(gt(objects.updatedAt, new Date(opts.updatedAfter)))

	const tokens = opts.q ? tokenizeKnowledgeQuery(opts.q) : []
	let scoreExpr: SQL<number> | null = null
	if (tokens.length > 0) {
		const parts = tokens.map((token) => {
			const pattern = `%${escapeIlike(token)}%`
			return sql`(case when (${objects.title} ilike ${pattern} or ${objects.content} ilike ${pattern}) then 1 else 0 end)`
		})
		scoreExpr = sql.join(parts, sql` + `) as SQL<number>
		// Only score-positive rows are candidates — matches T1 eval semantics
		// (rows with 0 token matches are not "returned" for that query).
		filters.push(sql`(${scoreExpr}) > 0`)
	}

	const orderBy: SQL[] = []
	if (scoreExpr) orderBy.push(desc(scoreExpr))
	orderBy.push(desc(verificationPriorityExpr))
	orderBy.push(desc(confidencePriorityExpr))
	// `t_valid` DESC NULLS LAST — most-recent live row wins the tiebreak, with
	// legacy rows (no `t_valid` metadata key) sorting last so they don't shadow
	// a promoted row.
	orderBy.push(sql`${safeTimestamp(metaTValid)} desc nulls last`)
	// Rows with no `t_valid`/verification/confidence metadata tie on all of the
	// above (fall to their NULL-equivalent defaults), so without this the result
	// would collapse to `id ASC` — an arbitrary UUID order, not newest-first.
	// `created_at DESC` restores the pre-migration default ordering for those rows.
	orderBy.push(desc(objects.createdAt))
	orderBy.push(asc(objects.id))

	const rows = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			type: objects.type,
			title: objects.title,
			content: objects.content,
			status: objects.status,
			metadata: objects.metadata,
			driver: objects.driver,
			activeSessionId: objects.activeSessionId,
			createdBy: objects.createdBy,
			createdAt: objects.createdAt,
			updatedAt: objects.updatedAt,
		})
		.from(objects)
		.where(and(...filters))
		.orderBy(...orderBy)
		.limit(opts.limit)
		.offset(opts.offset)

	return rows as KnowledgeRow[]
}
