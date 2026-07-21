// Source-markdown line diff for the reconcile "review" overlay. Runs against
// the canonical markdown string, not rendered HTML, per T4's serializer-
// stability constraint — the T1 round-trip pipeline is what makes the string
// comparison meaningful.

export type LineDiffSide = 'both' | 'mine' | 'theirs'

export interface DiffLineRow {
	kind: LineDiffSide
	mine: string | null
	theirs: string | null
}

// Longest-common-subsequence diff over line arrays. Small, dependency-free —
// we're diffing two versions of a single object's markdown body, so the O(n·m)
// table is fine for realistic sizes.
export function diffLines(mine: string, theirs: string): DiffLineRow[] {
	const a = mine.split('\n')
	const b = theirs.split('\n')
	const rows = a.length
	const cols = b.length

	const table: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0))
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i][j] =
				a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
		}
	}

	const out: DiffLineRow[] = []
	let i = 0
	let j = 0
	while (i < rows && j < cols) {
		if (a[i] === b[j]) {
			out.push({ kind: 'both', mine: a[i], theirs: b[j] })
			i++
			j++
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			out.push({ kind: 'mine', mine: a[i], theirs: null })
			i++
		} else {
			out.push({ kind: 'theirs', mine: null, theirs: b[j] })
			j++
		}
	}
	while (i < rows) {
		out.push({ kind: 'mine', mine: a[i], theirs: null })
		i++
	}
	while (j < cols) {
		out.push({ kind: 'theirs', mine: null, theirs: b[j] })
		j++
	}
	return out
}
