/**
 * Fetch every page of a list endpoint by calling `fetchPage({ limit, offset })`
 * with a fixed page size until a short page arrives, then return the flat list.
 *
 * The backend list schemas (`objectQuerySchema`, `relationshipQuerySchema`) cap
 * `limit` at 100 and default it to 50 — callers that omit `limit` silently miss
 * anything beyond the first 50. Use this helper whenever the frontend needs the
 * full set (e.g. building an in-memory index from workspace-wide rows) rather
 * than a display page.
 */
export const DEFAULT_PAGE_SIZE = 100

export async function fetchAllPages<T>(
	fetchPage: (params: { limit: number; offset: number }) => Promise<T[]>,
	pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
	const all: T[] = []
	let offset = 0
	while (true) {
		const page = await fetchPage({ limit: pageSize, offset })
		all.push(...page)
		if (page.length < pageSize) return all
		offset += page.length
	}
}
