/**
 * How many chips of a row fit before the rest must fold into a "More" menu.
 *
 * Pure so the rule can be tested without a browser: the caller measures the
 * row, the chips and the More chip, and renders the first `n` chips plus More
 * for the remainder. All chips show whenever they fit on their own (More is
 * then not drawn at all), and the first chip ("All") never folds.
 */
export function fitChips({
	available,
	widths,
	moreWidth,
	gap,
}: {
	/** Width of the row the chips share, in px. */
	available: number
	/** Natural width of each chip, in order. */
	widths: number[]
	/** Width of the More chip. */
	moreWidth: number
	/** Space between two chips. */
	gap: number
}): number {
	const count = widths.length
	if (count === 0) return 0
	const rowWidth = (n: number) =>
		widths.slice(0, n).reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1)
	if (rowWidth(count) <= available) return count
	for (let n = count - 1; n >= 1; n--) {
		if (rowWidth(n) + gap + moreWidth <= available) return n
	}
	return 1
}
