// Filters for the list tools that had none: list_loops, list_workspace_skills and list_extensions.
// They run in the MCP layer on the full row set, before the page is cut, so the
// page block's total is the filtered count and a cursor walk returns each match once.

/** Case-insensitive substring match of `q` against any of the fields. An empty `q` matches. */
export function matchesText(
	q: string | undefined,
	...fields: Array<string | null | undefined>
): boolean {
	const needle = q?.trim().toLowerCase()
	if (!needle) return true
	return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle))
}

/** A status given as one string or a list of strings, as a lower-case list. null means no filter. */
export function normalizeStatusFilter(status: string | string[] | undefined): string[] | null {
	if (status === undefined) return null
	const list = (Array.isArray(status) ? status : [status])
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0)
	return list.length > 0 ? list : null
}

/**
 * Rows that existed when the walk began. A cursor walk freezes at its first call, so the total in
 * the page block counts only those rows, the same set `paginateClientSide` walks.
 */
export function inSnapshot<T>(
	rows: readonly T[],
	snapshotAt: string,
	createdAtOf: (row: T) => string | null | undefined,
): T[] {
	return rows.filter((row) => {
		const created = createdAtOf(row)
		return !created || created <= snapshotAt
	})
}
