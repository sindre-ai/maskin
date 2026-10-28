// One matching rule and one ranking for every search surface: the ⌘K launcher
// and the /search page both rank through here, so the same query gives the same
// order. Pure functions with no React and no import from the palette component,
// so the redesigned launcher can reuse them.

function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
}

/** Edit distance (insert, delete, substitute, swap of neighbours); stops early once past `max`. */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1
	let beforePrev: number[] = []
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		const row = [i]
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			let best = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, beforePrev[j - 2] + 1)
			}
			row.push(best)
		}
		beforePrev = prev
		prev = row
	}
	return prev[b.length]
}

/** Typos allowed in a term. Short terms get none: one wrong letter there is a different word. */
function typoBudget(term: string): number {
	if (term.length >= 8) return 2
	return term.length >= 4 ? 1 : 0
}

/** True when `term` is a near miss of a word in `text` ("mgnus" for "Magnus"), or of the start of one. */
function fuzzyHit(term: string, text: string): boolean {
	const max = typoBudget(term)
	if (max === 0) return false
	return wordsOf(text).some(
		(word) =>
			editDistance(term, word, max) <= max ||
			(word.length > term.length && editDistance(term, word.slice(0, term.length), max) <= max),
	)
}

/**
 * True when every term of the query is found in some field, in any order and
 * not necessarily the same field ("baker anna" finds "Anna Baker"). A term of
 * four or more letters may also be a near miss of a word ("mgnus" finds "Magnus").
 */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length === 0) return true
	const haystacks = fields.map((field) => (field ?? '').toLowerCase())
	return terms.every((term) =>
		haystacks.some((haystack) => haystack.includes(term) || fuzzyHit(term, haystack)),
	)
}

/**
 * Initials match: a query of two or more letters ("nc") matches the first
 * letters of the words in a title ("New chat"). Only for commands and views,
 * whose titles are short phrases.
 */
export function initialsMatch(query: string, title: string): boolean {
	const typed = query.trim().toLowerCase()
	if (typed.length < 2 || !/^\p{L}+$/u.test(typed)) return false
	const initials = wordsOf(title)
		.map((word) => word[0])
		.join('')
	return initials.startsWith(typed)
}

/** True when any whitespace-separated term of the query appears in the title. */
export function titleMatches(query: string, title: string): boolean {
	const haystack = title.toLowerCase()
	return query
		.toLowerCase()
		.split(/\s+/)
		.some((term) => term.length > 0 && haystack.includes(term))
}

/** Share of the title (0..1) covered by the query terms found in it. */
export function titleCoverage(query: string, title: string): number {
	if (!title) return 0
	const haystack = title.toLowerCase()
	const matched = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0 && haystack.includes(term))
		.reduce((sum, term) => sum + term.length, 0)
	return Math.min(matched / title.length, 1)
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when `term` begins a word in `title` (so "b" matches "Anna Baker", not "Anna Eve"). */
function startsAWord(term: string, title: string): boolean {
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(title)
}

/**
 * How well a title matches, best first: the whole query typed at a word start
 * ("anna b" → "Anna Baker") beats every term starting a word, which beats a
 * term merely appearing somewhere, which beats a title with a typo in it,
 * which beats a content-only match.
 */
function titleTier(query: string, title: string): number {
	const lowerTitle = title.toLowerCase()
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length === 0) return 0
	if (startsAWord(terms.join(' '), lowerTitle)) return 3
	if (terms.every((term) => startsAWord(term, lowerTitle))) return 2
	if (titleMatches(query, title)) return 1
	return terms.every((term) => lowerTitle.includes(term) || fuzzyHit(term, lowerTitle)) ? 0.5 : 0
}

/**
 * Best title matches first; within a tier the largest share of the title
 * matched first, content-only matches last. Array.sort is stable, so the group
 * order (and the server's rank order) is kept among equals.
 */
export function rankTitleMatchesFirst<T extends { title: string }>(rows: T[], query: string): T[] {
	const scored = rows.map((row) => {
		const tier = titleTier(query, row.title)
		const phraseLength = query.trim().replace(/\s+/g, ' ').length
		const coverage =
			tier === 3
				? Math.min(phraseLength / (row.title.length || 1), 1)
				: titleCoverage(query, row.title)
		return { row, tier, coverage }
	})
	scored.sort((a, b) => b.tier - a.tier || b.coverage - a.coverage)
	return scored.map(({ row }) => row)
}
