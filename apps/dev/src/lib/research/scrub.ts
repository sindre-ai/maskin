import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import type {
	ExtractResult,
	ResearchSearchProvider,
	SearchParams,
	SearchResult,
} from './search-provider'

/**
 * The query scrub (spec 7.9): the backstop behind the data-use rule. Search
 * queries leave our boundary and the provider may train on them, so a query that
 * contains a name from the caller's own workspace (an object title, which is also
 * where contacts and companies keep their names) is rejected before the provider
 * is called. It matches names only: a described client situation that names
 * nobody gets through, and a public topic whose name is also a workspace title is
 * rejected. The prompt rule is the main protection.
 */

/** Names shorter than this are ignored: too short to mean anything as a whole phrase. */
const MIN_NAME_LENGTH = 4
/** A researcher that gets this many rejections stops and reports a gap. */
export const MAX_SCRUB_REJECTIONS_PER_RESEARCHER = 3

export const SCRUB_REJECTION_MESSAGE =
	'Query rejected: it contains a name from this workspace. Rewrite it with only the public topic.'

/**
 * Case, diacritics, punctuation and spacing folded away, and Danish æ, ø, å
 * folded to ae, oe, aa so "Bogføring" matches "bogfoering". Order matters: the
 * Danish letters go before the diacritic strip, which would turn å into a.
 */
export function normalizeForScrub(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'oe')
		.replace(/å/g, 'aa')
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

export interface QueryScrub {
	/** True when the query contains a workspace name as a whole phrase. */
	containsName(query: string): boolean
}

/** Matches by word n-grams of the query against a set, so thousands of titles stay cheap. */
export function createQueryScrub(names: Iterable<string>): QueryScrub {
	const set = new Set<string>()
	let maxWords = 0
	for (const name of names) {
		const normalized = normalizeForScrub(name)
		if (normalized.length < MIN_NAME_LENGTH) continue
		set.add(normalized)
		maxWords = Math.max(maxWords, normalized.split(' ').length)
	}
	return {
		containsName(query) {
			if (set.size === 0) return false
			const words = normalizeForScrub(query).split(' ').filter(Boolean)
			for (let start = 0; start < words.length; start++) {
				const longest = Math.min(maxWords, words.length - start)
				for (let len = 1; len <= longest; len++) {
					if (set.has(words.slice(start, start + len).join(' '))) return true
				}
			}
			return false
		},
	}
}

/** Thrown by the wrapped provider when a query is refused. The matched name is never in it. */
export class QueryRejectedError extends Error {
	constructor() {
		super(SCRUB_REJECTION_MESSAGE)
		this.name = 'QueryRejectedError'
	}
}

/**
 * The single choke point: every search goes through this wrapper, so the scrub
 * covers simple effort and every later path. A rejected query never reaches the
 * provider, so it costs nothing. Extract is not scrubbed: it sends URLs the
 * provider returned, not query text.
 */
export function withQueryScrub(
	provider: ResearchSearchProvider,
	scrub: QueryScrub,
): ResearchSearchProvider {
	return {
		name: provider.name,
		searchPriceMicroUsd: provider.searchPriceMicroUsd,
		extractUrlPriceMicroUsd: provider.extractUrlPriceMicroUsd,
		search(params: SearchParams): Promise<SearchResult> {
			if (scrub.containsName(params.query)) return Promise.reject(new QueryRejectedError())
			return provider.search(params)
		},
		extract(urls: string[]): Promise<ExtractResult> {
			return provider.extract(urls)
		},
	}
}

/**
 * Titles of the caller's workspace objects that are not archived. Contacts and
 * companies are objects, so their names are titles. Built once per run, from the
 * caller's workspace only.
 */
export async function loadWorkspaceNames(db: Database, workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ title: objects.title })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				ne(objects.status, 'archived'),
				isNotNull(objects.title),
			),
		)
	return rows.map((r) => r.title).filter((t): t is string => typeof t === 'string')
}
