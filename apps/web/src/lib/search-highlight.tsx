import type { ReactNode } from 'react'

// Real <mark> highlighting for search results (command palette + /search view).
// Splits the text on every case-insensitive occurrence of the trimmed query and
// wraps matches in <mark> — the styling rule lives in app.css, cell text is
// plain ReactNodes so there is never an innerHTML injection surface.
export function highlightText(text: string | null | undefined, query: string): ReactNode {
	const plain = text ?? ''
	const q = query.trim().toLowerCase()
	if (!q) return plain
	const lower = plain.toLowerCase()
	const parts: ReactNode[] = []
	let cursor = 0
	let key = 0
	while (true) {
		const idx = lower.indexOf(q, cursor)
		if (idx === -1) {
			if (cursor < plain.length) parts.push(plain.slice(cursor))
			break
		}
		if (idx > cursor) parts.push(plain.slice(cursor, idx))
		parts.push(<mark key={key++}>{plain.slice(idx, idx + q.length)}</mark>)
		cursor = idx + q.length
	}
	return parts
}
