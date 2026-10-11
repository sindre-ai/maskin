// Shared stopword set for `q` tokenization — kept verbatim in sync with the
// offline eval harness so a post-merge run against the seeded fixtures returns
// the same rows in the same order as the pre-merge T1 numbers.
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
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

/** ILIKE pattern matching `token` anywhere, with LIKE wildcards escaped. */
export function tokenIlikePattern(token: string): string {
	return `%${escapeLike(token)}%`
}

/** Escape `%`, `_` and `\\` so user input is matched literally by LIKE/ILIKE. */
export function escapeLike(value: string): string {
	return value.replace(/[%_\\]/g, '\\$&')
}
