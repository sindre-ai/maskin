/**
 * Lightweight glob matcher for protected-path patterns.
 *
 * Supports `**`, `*`, `?` and literal characters. Anchored at both ends.
 * Using a custom matcher avoids pulling a runtime dep just for a few patterns.
 */
export function globMatch(pattern: string, path: string): boolean {
	const re = new RegExp(`^${globToRegexBody(pattern)}$`)
	return re.test(path)
}

function globToRegexBody(pattern: string): string {
	let out = ''
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				out += '.*'
				i++
				if (pattern[i + 1] === '/') i++
			} else {
				out += '[^/]*'
			}
		} else if (c === '?') {
			out += '[^/]'
		} else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
			out += `\\${c}`
		} else if (c !== undefined) {
			out += c
		}
	}
	return out
}
