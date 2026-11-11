/**
 * Builds Deepdots list requests and trims the answers.
 *
 * Agents never send Deepdots filter JSON. They send plain inputs (limit, skip, since, search)
 * and this file turns them into the one filter shape we have checked, so the filter quirks in
 * the Deepdots docs cannot be reached from outside:
 *  - paging needs an explicit order with the id as tiebreaker, because many rows share a date;
 *  - only the first operator in a condition is applied, so each condition carries exactly one;
 *  - a "]" directly followed by "=" makes Deepdots ignore the whole filter and return every row;
 *  - the characters + & # % = in a value must be escaped.
 */

export const DEEPDOTS_BASE_URL = 'https://api.deepdots.com'

export const MAX_LIMIT = 50
export const DEFAULT_LIMIT = 20
/** Deepdots has no cursor. A bound on skip keeps the filter a plain integer. */
export const MAX_SKIP = 100_000
const MAX_TEXT_LENGTH = 600

export type DeepdotsList = 'insights' | 'issues' | 'opportunities' | 'topics'

interface ListSpec {
	path: string
	/** Newest first. Null when the route has no date to sort by. */
	dateField: string | null
	/** Last sort key, so rows that share the date keep one stable order across pages. */
	tiebreaker: string
	/** True when the route has a text search (the "search" query parameter). */
	searchable: boolean
	/** The fields an agent gets back. Anything else is dropped. */
	fields: readonly string[]
}

// Field names come from the Deepdots OpenAPI spec (2.2.14). They have not been checked against a
// live answer yet (the kill check needs a test login), so a wrong name here is a one-line fix.
export const LIST_SPECS: Record<DeepdotsList, ListSpec> = {
	insights: {
		path: '/feedbacks/insight',
		dateField: 'generatedAt',
		tiebreaker: 'id',
		searchable: false,
		fields: ['id', 'name', 'summary', 'status', 'identity', 'type', 'generatedAt', 'updatedAt'],
	},
	issues: {
		path: '/topics/issues',
		dateField: 'externalGeneratedAt',
		tiebreaker: 'id',
		searchable: false,
		fields: [
			'id',
			'issues_name',
			'issues_reason',
			'issues_category',
			'issues_priority',
			'issues_score',
			'issues_status',
			'issues_extracts_original',
			'issues_topics',
			'externalGeneratedAt',
		],
	},
	opportunities: {
		path: '/topics/opportunities/unified',
		dateField: 'last_generated_at',
		tiebreaker: 'slug',
		searchable: true,
		fields: [
			'slug',
			'opportunity_name',
			'opportunity_description',
			'type',
			'severity',
			'topics',
			'total_issues',
			'last_generated_at',
		],
	},
	topics: {
		path: '/dimensions/topics',
		dateField: null,
		tiebreaker: 'topic',
		searchable: false,
		fields: [
			'topic',
			'severity',
			'num_feedback',
			'num_issues',
			'num_values',
			'change_7d',
			'change_30d',
		],
	},
}

export interface ListInput {
	limit?: number
	skip?: number
	since?: string
	search?: string
}

export type BuiltRequest = { ok: true; url: string; limit: number } | { ok: false; message: string }

const ESCAPED = /[+&#%=]/g

/**
 * Writes the filter as JSON with + & # % = turned into \\uXXXX escapes. Those characters only
 * ever sit inside strings in JSON (its own punctuation is {}[]",:), so the result is still valid
 * JSON that decodes to the same value, and none of the five reaches the wire as itself.
 */
export function serializeFilter(filter: Record<string, unknown>): string {
	return JSON.stringify(filter).replace(
		ESCAPED,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
	)
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * The URL for one page. Asks for one row more than `limit`, so the caller can tell whether
 * another page exists without a count call.
 */
export function buildListRequest(list: DeepdotsList, input: ListInput): BuiltRequest {
	const spec = LIST_SPECS[list]
	const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
	const skip = clampInt(input.skip, 0, 0, MAX_SKIP)

	const order = [...(spec.dateField ? [`${spec.dateField} DESC`] : []), `${spec.tiebreaker} DESC`]
	const filter: Record<string, unknown> = { limit: limit + 1, skip, order }

	if (input.since !== undefined) {
		if (!spec.dateField) return { ok: false, message: `since is not available for ${list}.` }
		const when = new Date(input.since)
		if (Number.isNaN(when.getTime())) {
			return {
				ok: false,
				message: 'since must be a date such as 2026-11-01 or 2026-11-01T09:00:00Z.',
			}
		}
		// One operator in the condition: Deepdots applies only the first.
		filter.where = { [spec.dateField]: { gte: when.toISOString() } }
	}

	const params = [`filter=${encodeURIComponent(serializeFilter(filter))}`]
	if (input.search !== undefined && input.search.trim() !== '') {
		if (!spec.searchable) return { ok: false, message: `search is not available for ${list}.` }
		params.push(`search=${encodeURIComponent(input.search.trim().slice(0, 200))}`)
	}
	return { ok: true, url: `${DEEPDOTS_BASE_URL}${spec.path}?${params.join('&')}`, limit }
}

function trimValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}...` : value
	}
	if (Array.isArray(value)) return value.slice(0, 20).map(trimValue)
	return value
}

/** Rows from the answer. Deepdots lists are plain arrays; a wrapped list is read too. */
function rowsOf(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body
	if (body && typeof body === 'object') {
		for (const key of ['data', 'items', 'results']) {
			const inner = (body as Record<string, unknown>)[key]
			if (Array.isArray(inner)) return inner
		}
	}
	return null
}

export interface TrimmedPage {
	items: Record<string, unknown>[]
	has_more: boolean
	next_skip: number | null
}

/** Cuts the answer to the fields we offer and to `limit` rows. Null when it is not a list. */
export function trimPage(
	list: DeepdotsList,
	body: unknown,
	limit: number,
	skip: number,
): TrimmedPage | null {
	const rows = rowsOf(body)
	if (!rows) return null
	const fields = LIST_SPECS[list].fields
	const items = rows.slice(0, limit).map((row) => {
		const source = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const field of fields) {
			if (source[field] !== undefined) out[field] = trimValue(source[field])
		}
		return out
	})
	const hasMore = rows.length > limit
	return { items, has_more: hasMore, next_skip: hasMore ? skip + limit : null }
}
