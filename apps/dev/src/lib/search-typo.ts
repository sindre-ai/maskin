// Typo matching for the second pass of GET /api/search (services/search.ts).
// editDistance, typoBudget and wordsOf are the ones from apps/web/src/lib/palette/ranking.ts
// (PR 2511), kept as they are. The server only returns rows that already matched, so the
// browser can no longer do this part.

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

/** True when a word of this length may be matched with typos at all (4 letters or more). */
export function canHaveTypo(term: string): boolean {
	return typoBudget(term) > 0
}

/**
 * How many typos it takes to find `term` in `text`: 0 when it appears as written, otherwise the
 * smallest edit distance to a word of the text or to the start of one ("mgnus" in "Magnus" is 1).
 * Null when it is out of the term's typo budget.
 */
function termDistance(term: string, text: string): number | null {
	if (text.includes(term)) return 0
	const max = typoBudget(term)
	if (max === 0) return null
	let best = max + 1
	for (const word of wordsOf(text)) {
		best = Math.min(best, editDistance(term, word, max))
		if (word.length > term.length) {
			best = Math.min(best, editDistance(term, word.slice(0, term.length), max))
		}
	}
	return best <= max ? best : null
}

/**
 * Total typos over the lower-cased query words when every word is found in the title (in any
 * order), null when one is not. Lower is a closer match.
 */
export function titleTypoDistance(tokens: string[], title: string): number | null {
	const lowerTitle = title.toLowerCase()
	let total = 0
	for (const token of tokens) {
		const distance = termDistance(token, lowerTitle)
		if (distance === null) return null
		total += distance
	}
	return total
}
