import type { DataQueryResult } from '@maskin/shared'

// The server answers a data query a page of groups at a time, so no single response is huge. A
// custom view should not have to know that: it asks once and gets every group. This follows the
// cursors and hands back one merged answer.

/** Re-reads from the start this many times if the pages stop lining up (see below). */
const MAX_RESTARTS = 2
/** A guard against a server that never stops handing out cursors; real reads end far sooner. */
const MAX_PAGES = 10_000

/** What `readPage(null)` means: the first page. Any other value is a `next_cursor`. */
export type ReadPage = (cursor: string | null) => Promise<DataQueryResult>

const sameTotal = (a: DataQueryResult, b: DataQueryResult) =>
	a.total.count === b.total.count && a.total.value === b.total.value

/**
 * Every group of a query, merged from all its pages into one result with no cursor.
 *
 * The server cuts later pages from a snapshot of the first one, so they agree. If that snapshot
 * expired mid-read the server recomputes, and the new numbers may not match the pages already
 * read; the totals differing is how that shows, and the read starts over (a couple of times,
 * then it takes what it has rather than failing the view).
 */
export async function readEveryPage(readPage: ReadPage): Promise<DataQueryResult> {
	for (let attempt = 0; ; attempt++) {
		const first = await readPage(null)
		const groups = [...first.groups]
		let cursor = first.next_cursor
		let linedUp = true

		for (let pages = 1; cursor; pages++) {
			if (pages > MAX_PAGES) throw new Error('The query returned too many pages')
			const page = await readPage(cursor)
			if (!sameTotal(first, page) && attempt < MAX_RESTARTS) {
				linedUp = false
				break
			}
			groups.push(...page.groups)
			cursor = page.next_cursor
		}

		if (linedUp) {
			return { ...first, groups, next_cursor: null, rows_truncated: false, groups_truncated: false }
		}
	}
}
