// The "Ask Chief of Staff" row and the launcher's empty-state wording.

export const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

export function wordCount(query: string): number {
	return query.trim().split(/\s+/).filter(Boolean).length
}

/**
 * The Ask row closes the list when the query reads like a question or a
 * request: three or more words, a trailing question mark, or nothing found.
 */
export function shouldOfferAsk(query: string, hasMatches: boolean): boolean {
	const typed = query.trim()
	if (!typed) return false
	return wordCount(typed) >= 3 || typed.endsWith('?') || !hasMatches
}

export function askRowTitle(query: string): string {
	return `Ask ${CHIEF_OF_STAFF_NAME}: “${query.trim()}”`
}

/** The workspace's Chief of Staff agent, if it has one. */
export function findChiefOfStaff<T extends { type: string; name: string }>(
	actors: T[] | undefined,
): T | undefined {
	return actors?.find((a) => a.type === 'agent' && /^chief of staff\b/i.test(a.name.trim()))
}

export function emptyStateText(query: string): string {
	return `Nothing matches “${query.trim()}”. Try fewer words, or ask an agent.`
}

/** Sub line of the terminal Search row. */
export function searchRowSub(count: number): string {
	if (count === 0) return 'no matches, try fewer words or other types'
	return `${count} ${count === 1 ? 'match' : 'matches'} · filterable results`
}
