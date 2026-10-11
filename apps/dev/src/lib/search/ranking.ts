import { type SQL, type SQLWrapper, and, or, sql } from 'drizzle-orm'
import { SEARCH_STOPWORDS, escapeLike, tokenIlikePattern } from './tokens'

/**
 * Ranking + pagination helpers for `POST /api/search`.
 *
 * Everything here compiles to plain SQL over existing columns (no new index,
 * no extension): the score is an integer sum of ILIKE-driven CASE terms, so the
 * ORDER BY `(score DESC, updated_ms DESC, id ASC)` is a total, deterministic
 * order that a keyset cursor can seek on.
 */

/**
 * Weights of the score terms. Titles dominate; content is a tie-breaking whisper.
 * Invariant: content can never outscore a single title-token hit — with at most
 * MAX_TOKENS (8) tokens, allTokensPresent + 8 * contentToken = 31 < titleToken.
 */
export const SEARCH_WEIGHTS = {
	/** lower(title) equals the whole (whitespace-normalised) query. */
	exactTitle: 1000,
	/** title starts with the whole query. */
	titlePrefix: 400,
	/** every token occurs somewhere in the title. */
	allTokensInTitle: 200,
	/** per token occurring in the title. */
	titleToken: 40,
	/** every token occurs somewhere in title or content. */
	allTokensPresent: 15,
	/** per token occurring in the content (objects/loops only). */
	contentToken: 2,
} as const

const MAX_TOKENS = 8

export interface SearchTerms {
	/** Lowercased query with whitespace collapsed. */
	phrase: string
	tokens: string[]
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * Tokenize a free-text query. Same stopword set and min-length rule as the
 * legacy `q` tokenizer, but Unicode-aware (titles are not ASCII-only) and with
 * a fallback so short or all-stopword queries ("Q3", "to do", "AI") still search
 * instead of collapsing to "match everything".
 */
export function buildSearchTerms(query: string): SearchTerms {
	const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim()
	const words = phrase
		.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 0 && WORD_CHAR_RE.test(w))
	const dedupe = (list: string[]) => [...new Set(list)]
	let tokens = dedupe(words.filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w)))
	if (tokens.length === 0) tokens = dedupe(words)
	if (tokens.length === 0 && phrase.length > 0) tokens = [phrase]
	return { phrase, tokens: tokens.slice(0, MAX_TOKENS) }
}

/** `col ilike pattern` where `col` may be any SQL fragment/column. */
function ilikeSql(col: SQLWrapper, pattern: string): SQL {
	return sql`${col} ilike ${pattern}`
}

/** Rows whose title (or, when given, content) contains at least one token. */
export function buildMatchCondition(
	terms: SearchTerms,
	title: SQLWrapper,
	content?: SQLWrapper,
): SQL {
	const perToken = terms.tokens.map((t) => {
		const p = tokenIlikePattern(t)
		return content
			? (or(ilikeSql(title, p), ilikeSql(sql`coalesce(${content}, '')`, p)) as SQL)
			: ilikeSql(title, p)
	})
	return or(...perToken) as SQL
}

/**
 * Integer relevance score. See SEARCH_WEIGHTS for the formula:
 *   exactTitle + titlePrefix + allTokensInTitle + Σ titleToken
 *   + allTokensPresent + Σ contentToken
 */
export function buildScoreExpr(terms: SearchTerms, title: SQLWrapper, content?: SQLWrapper): SQL {
	const w = Object.fromEntries(
		Object.entries(SEARCH_WEIGHTS).map(([k, v]) => [k, sql.raw(String(v))]),
	) as Record<keyof typeof SEARCH_WEIGHTS, SQL>
	const patterns = terms.tokens.map(tokenIlikePattern)
	const contentOrEmpty = content ? sql`coalesce(${content}, '')` : null
	const parts: SQL[] = [
		sql`(case when lower(${title}) = ${terms.phrase} then ${w.exactTitle} else 0 end)`,
		sql`(case when ${ilikeSql(title, `${escapeLike(terms.phrase)}%`)} then ${w.titlePrefix} else 0 end)`,
		sql`(case when ${and(...patterns.map((p) => ilikeSql(title, p)))} then ${w.allTokensInTitle} else 0 end)`,
		...patterns.map((p) => sql`(case when ${ilikeSql(title, p)} then ${w.titleToken} else 0 end)`),
		sql`(case when ${and(
			...patterns.map((p) =>
				contentOrEmpty
					? (or(ilikeSql(title, p), ilikeSql(contentOrEmpty, p)) as SQL)
					: ilikeSql(title, p),
			),
		)} then ${w.allTokensPresent} else 0 end)`,
	]
	if (contentOrEmpty) {
		for (const p of patterns) {
			parts.push(sql`(case when ${ilikeSql(contentOrEmpty, p)} then ${w.contentToken} else 0 end)`)
		}
	}
	return sql`(${sql.join(parts, sql` + `)})::int`
}

/** Millisecond-truncated epoch of a timestamp column — exact in numeric, so the cursor round-trips. */
export function buildUpdatedMsExpr(updated: SQLWrapper): SQL {
	return sql`floor(extract(epoch from ${updated}) * 1000)::bigint`
}

export interface SearchCursor {
	/** score of the last row of the previous page */
	s: number
	/** updated_ms of the last row of the previous page */
	u: number
	/** id of the last row of the previous page */
	i: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeSearchCursor(cursor: SearchCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Returns `null` for anything that is not a cursor this server minted. */
export function decodeSearchCursor(raw: string): SearchCursor | null {
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, 'base64url').toString('utf8'),
		) as Partial<SearchCursor>
		if (
			typeof parsed.s !== 'number' ||
			!Number.isSafeInteger(parsed.s) ||
			typeof parsed.u !== 'number' ||
			!Number.isSafeInteger(parsed.u) ||
			typeof parsed.i !== 'string' ||
			!UUID_RE.test(parsed.i)
		) {
			return null
		}
		return { s: parsed.s, u: parsed.u, i: parsed.i.toLowerCase() }
	} catch {
		return null
	}
}

/** Keyset predicate: rows strictly after `cursor` in (score DESC, updated_ms DESC, id ASC). */
export function buildCursorCondition(
	cursor: SearchCursor,
	scoreExpr: SQL,
	updatedMsExpr: SQL,
	idCol: SQLWrapper,
): SQL {
	const u = String(cursor.u)
	return or(
		sql`${scoreExpr} < ${cursor.s}`,
		and(sql`${scoreExpr} = ${cursor.s}`, sql`${updatedMsExpr} < ${u}::bigint`),
		and(
			sql`${scoreExpr} = ${cursor.s}`,
			sql`${updatedMsExpr} = ${u}::bigint`,
			sql`${idCol}::text > ${cursor.i}`,
		),
	) as SQL
}

export interface RankedRow {
	id: string
	score: number
	ms: number
}

/** Same total order as the SQL ORDER BY, for merging per-source pages. */
export function compareRanked(a: RankedRow, b: RankedRow): number {
	if (a.score !== b.score) return b.score - a.score
	if (a.ms !== b.ms) return b.ms - a.ms
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Collapse whitespace and trim to a short single-line excerpt. */
export function toSnippet(head: string, max = 140): string | undefined {
	const flat = head.replace(/\s+/g, ' ').trim()
	if (!flat) return undefined
	return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}
