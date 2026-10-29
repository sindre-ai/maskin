// JSONPath subset used by webhook event mapping
// ─────────────────────────────────────────────
// Supports exactly what event mapping needs: "$" root, ".key", "['key']" /
// '["key"]' and "[n]" array indexes. No wildcards, filters or recursive
// descent, so there is no dependency to vet and no way to write a path that
// fans out to several values.

export type PathStep = string | number

export function parseJsonPath(path: string): PathStep[] | null {
	if (!path.startsWith('$')) return null
	const steps: PathStep[] = []
	let i = 1
	while (i < path.length) {
		const ch = path[i]
		if (ch === '.') {
			const m = /^[A-Za-z0-9_$-]+/.exec(path.slice(i + 1))
			if (!m) return null
			steps.push(m[0])
			i += 1 + m[0].length
		} else if (ch === '[') {
			const rest = path.slice(i)
			const idx = /^\[(\d+)\]/.exec(rest)
			const key = /^\[(?:'([^']*)'|"([^"]*)")\]/.exec(rest)
			if (idx?.[1] !== undefined) {
				steps.push(Number(idx[1]))
				i += idx[0].length
			} else if (key) {
				steps.push(key[1] ?? key[2] ?? '')
				i += key[0].length
			} else {
				return null
			}
		} else {
			return null
		}
	}
	return steps
}

/** Value at the path, or undefined when the path is malformed or does not resolve. */
export function evalJsonPath(payload: unknown, path: string): unknown {
	const steps = parseJsonPath(path)
	if (!steps) return undefined
	let cur: unknown = payload
	for (const step of steps) {
		if (cur === null || typeof cur !== 'object') return undefined
		if (typeof step === 'number') {
			if (!Array.isArray(cur)) return undefined
			cur = cur[step]
		} else {
			if (Array.isArray(cur)) return undefined
			cur = (cur as Record<string, unknown>)[step]
		}
	}
	return cur
}

/** True when the path parses in the supported subset. */
export function isValidJsonPath(path: string): boolean {
	return parseJsonPath(path) !== null
}
