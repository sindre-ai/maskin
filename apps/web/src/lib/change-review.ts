// Pure helpers for the agent change review screen. The server stores only about
// 40 characters of context per change, so the blocks around a change and the
// "N unchanged block(s)" rows are built here from the file text as it is now.

export interface ReviewChangeInput {
	id: string
	oldText: string
	ordinal: number
}

export interface TextBlock {
	start: number
	end: number
	text: string
}

export type ReviewItem =
	| { kind: 'context'; key: string; text: string }
	| { kind: 'gap'; key: string; count: number }
	| { kind: 'change'; key: string; changeId: string; number: number }

export type DiffPart = { type: 'same' | 'del' | 'ins'; text: string }

/** Splits markdown source into blocks on blank lines. Blank lines inside a code fence do not split. */
export function splitBlocks(text: string): TextBlock[] {
	const blocks: TextBlock[] = []
	const lines = text.split('\n')
	let offset = 0
	let start = -1
	let end = -1
	let fence: string | null = null
	for (const line of lines) {
		const lineStart = offset
		offset += line.length + 1
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
		if (marker) {
			if (fence === null) fence = marker[0] ?? null
			else if (marker[0] === fence) fence = null
		}
		const blank = fence === null && line.trim() === ''
		if (blank) {
			if (start >= 0) {
				blocks.push({ start, end, text: text.slice(start, end) })
				start = -1
			}
			continue
		}
		if (start < 0) start = lineStart
		end = lineStart + line.length
	}
	if (start >= 0) blocks.push({ start, end, text: text.slice(start, end) })
	return blocks
}

/** Markdown stripped to plain text for a muted context block. */
export function stripMarkdown(block: string): string {
	return block
		.replace(/^\s{0,3}```[^\n]*\n?/gm, '')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s{0,3}>\s?/gm, '')
		.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		.replace(/(\*|_)(.*?)\1/g, '$2')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\s*\n\s*/g, ' ')
		.trim()
}

function occurrences(haystack: string, needle: string): number {
	if (needle === '') return 0
	let count = 0
	let from = 0
	for (;;) {
		const at = haystack.indexOf(needle, from)
		if (at < 0) return count
		count++
		from = at + needle.length
	}
}

/**
 * Lays out the review view: one card per change at the place its old text sits
 * in the file, the block on each side of a change as muted context, and a gap
 * row for every run of blocks in between. A change whose old text no longer
 * occurs exactly once in the text is left out; the server marks those stale.
 */
export function buildReviewItems(fileText: string, changes: ReviewChangeInput[]): ReviewItem[] {
	const blocks = splitBlocks(fileText)
	const placed = changes
		.filter((c) => occurrences(fileText, c.oldText) === 1)
		.map((c) => {
			const at = fileText.indexOf(c.oldText)
			const to = at + c.oldText.length
			let first = blocks.findIndex((b) => b.end > at)
			if (first < 0) first = blocks.length - 1
			let last = first
			while (last + 1 < blocks.length && (blocks[last + 1] as TextBlock).start < to) last++
			return { change: c, at, first, last }
		})
		.sort((a, b) => a.at - b.at || a.change.ordinal - b.change.ordinal)

	const changed = new Set<number>()
	for (const p of placed) for (let i = p.first; i <= p.last; i++) changed.add(i)
	const near = (i: number) => changed.has(i - 1) || changed.has(i + 1)

	const items: ReviewItem[] = []
	let gap = 0
	let number = 0
	const flushGap = (key: string) => {
		if (gap > 0) items.push({ kind: 'gap', key, count: gap })
		gap = 0
	}
	let nextChange = 0
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i] as TextBlock
		if (changed.has(i)) {
			flushGap(`gap-${i}`)
			// Every change that starts in this block gets its card, in document order.
			while (nextChange < placed.length && (placed[nextChange] as (typeof placed)[0]).first === i) {
				const p = placed[nextChange] as (typeof placed)[0]
				number++
				items.push({ kind: 'change', key: p.change.id, changeId: p.change.id, number })
				nextChange++
			}
			continue
		}
		if (near(i)) {
			flushGap(`gap-${i}`)
			items.push({ kind: 'context', key: `ctx-${i}`, text: stripMarkdown(block.text) })
		} else gap++
	}
	flushGap('gap-end')
	return items
}

/** Word level diff. Whitespace stays attached to the words around it. */
export function wordDiff(before: string, after: string): DiffPart[] {
	const a = before.match(/\S+\s*|\s+/g) ?? []
	const b = after.match(/\S+\s*|\s+/g) ?? []
	const key = (t: string) => t.trim()
	const n = a.length
	const m = b.length
	// Very long texts fall back to a whole-text replace instead of a big table.
	if (n * m > 4_000_000) return replaceAll(before, after)

	const table = new Uint32Array((n + 1) * (m + 1))
	const w = m + 1
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * w + j] =
				key(a[i] as string) === key(b[j] as string)
					? (table[(i + 1) * w + j + 1] as number) + 1
					: Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number)
		}
	}

	const parts: DiffPart[] = []
	const push = (type: DiffPart['type'], text: string) => {
		const last = parts[parts.length - 1]
		if (last && last.type === type) last.text += text
		else parts.push({ type, text })
	}
	let i = 0
	let j = 0
	while (i < n && j < m) {
		if (key(a[i] as string) === key(b[j] as string)) {
			push('same', b[j] as string)
			i++
			j++
		} else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) {
			push('del', a[i++] as string)
		} else {
			push('ins', b[j++] as string)
		}
	}
	while (i < n) push('del', a[i++] as string)
	while (j < m) push('ins', b[j++] as string)
	return parts
}

function replaceAll(before: string, after: string): DiffPart[] {
	const parts: DiffPart[] = []
	if (before) parts.push({ type: 'del', text: before })
	if (after) parts.push({ type: 'ins', text: after })
	return parts
}
