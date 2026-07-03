import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { knowledgeExtras } from './schema'

// Column-aware retrieval for `type='knowledge'` objects. Left-joins
// `knowledge_extras` on `object_id` and filters/ranks by the first-class
// columns promoted in migration `0043_knowledge_extras.sql`:
//
//  - bi-temporal live-only: rows with `t_invalid IS NOT NULL` are excluded,
//    and rows scheduled for a future validity (`t_valid > now`) are excluded
//    so the candidate set reflects what is in-force right now.
//  - `verification_status='deprecated'` rows are excluded.
//  - order: token-score DESC (when `q` is provided) → verification priority
//    (verified > pending > unverified > contested) → confidence priority
//    (high > medium > low > NULL) → `t_valid` DESC NULLS LAST (recency is a
//    first-class tiebreaker now that the column is promoted) → id ASC.
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
	limit: number
	offset: number
}

export type KnowledgeRow = typeof objects.$inferSelect

// Verification / confidence rank expressions used both in the ORDER BY and
// (for verification) as the deprecated-exclusion filter. Kept as SQL fragments
// so Postgres does the comparison on the same tuple LEFT-JOIN returns.
const verificationPriorityExpr = sql<number>`case ${knowledgeExtras.verificationStatus}
	when 'verified' then 3
	when 'pending' then 2
	when 'unverified' then 1
	when 'contested' then 0
	else 1
end`

const confidencePriorityExpr = sql<number>`case ${knowledgeExtras.confidence}
	when 'high' then 3
	when 'medium' then 2
	when 'low' then 1
	else 0
end`

export async function retrieveKnowledge(
	db: Database,
	opts: RetrieveKnowledgeOptions,
): Promise<KnowledgeRow[]> {
	const filters: SQL[] = [eq(objects.workspaceId, opts.workspaceId), eq(objects.type, 'knowledge')]

	// Bi-temporal live-only. LEFT JOIN means missing extras row → t_invalid IS NULL
	// naturally, so nothing is excluded on that account.
	filters.push(isNull(knowledgeExtras.tInvalid))

	// In-force at query time. Rows with `t_valid > now` are scheduled for a
	// future validity and should not be candidates yet. Missing extras row
	// (LEFT JOIN null) keeps legacy rows retrievable.
	filters.push(or(isNull(knowledgeExtras.tValid), sql`${knowledgeExtras.tValid} <= now()`) as SQL)

	// `deprecated` verification means the row is intentionally out of retrieval.
	// Missing extras row (LEFT JOIN null) is treated as retrievable — the extension
	// may not be populated for a workspace, and we don't want to hide legacy rows.
	filters.push(
		or(
			isNull(knowledgeExtras.verificationStatus),
			sql`${knowledgeExtras.verificationStatus} <> 'deprecated'`,
		) as SQL,
	)

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
	// legacy rows (no extras row) sorting last so they don't shadow a promoted row.
	orderBy.push(sql`${knowledgeExtras.tValid} desc nulls last`)
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
		.leftJoin(knowledgeExtras, eq(knowledgeExtras.objectId, objects.id))
		.where(and(...filters))
		.orderBy(...orderBy)
		.limit(opts.limit)
		.offset(opts.offset)

	return rows as KnowledgeRow[]
}
