const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * Alphabetical by the label the user sees (A→Z, case-insensitive, `Agent 2` before `Agent 10`).
 * Items with no label go last. Ties break on `tiebreak` so the order never flickers on refetch.
 */
export function sortBy<T>(
	items: readonly T[],
	label: (item: T) => string,
	tiebreak: (item: T) => string,
): T[] {
	return [...items].sort((a, b) => {
		const la = label(a)
		const lb = label(b)
		if (!la !== !lb) return la ? -1 : 1
		return collator.compare(la, lb) || tiebreak(a).localeCompare(tiebreak(b))
	})
}

/** `sortBy` for items with a `name`; ties break on `id`, or on `tiebreak` when there is no `id`. */
export function sortByName<T extends { id: string; name: string }>(items: readonly T[]): T[]
export function sortByName<T extends { name: string }>(
	items: readonly T[],
	tiebreak: (item: T) => string,
): T[]
export function sortByName<T extends { name: string }>(
	items: readonly T[],
	tiebreak: (item: T) => string = (item) => (item as unknown as { id: string }).id,
): T[] {
	return sortBy(items, (item) => item.name, tiebreak)
}
