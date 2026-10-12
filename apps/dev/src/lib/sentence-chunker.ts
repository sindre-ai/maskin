/**
 * Cuts a streamed reply into speakable sentences as the model produces them, so
 * text-to-speech can start on the first sentence while the rest is still being
 * written. A sentence is released only once the character after its punctuation
 * has arrived, which is how "3.5" and "e.g. this" stay whole.
 */
export interface SentenceChunkerOptions {
	/** Shorter fragments are merged into the next sentence. */
	minChars?: number
	/** A run with no boundary this long is split at a comma or space. */
	maxChars?: number
}

const TERMINAL = new Set(['.', '!', '?', '…'])
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’'])
const ABBREVIATIONS = new Set([
	'mr',
	'mrs',
	'ms',
	'dr',
	'prof',
	'sr',
	'jr',
	'st',
	'vs',
	'etc',
	'approx',
	'no',
	'inc',
	'ltd',
	'e.g',
	'i.e',
])

function isWhitespace(ch: string | undefined): boolean {
	return ch !== undefined && /\s/.test(ch)
}

/** True when the period ending at `end` (exclusive) belongs to an abbreviation or an initial. */
function endsWithAbbreviation(text: string, end: number): boolean {
	const before = text.slice(0, end - 1)
	const m = /([A-Za-z][A-Za-z.]*)$/.exec(before)
	if (!m) return false
	const token = m[1] ?? ''
	if (ABBREVIATIONS.has(token.toLowerCase())) return true
	// A single capital letter is an initial: "J. Smith".
	return /^[A-Z]$/.test(token)
}

export interface SentenceChunker {
	push(delta: string): string[]
	/** Releases whatever is left, including a trailing fragment. */
	flush(): string[]
	/** Text received but not yet released. */
	pending(): string
}

export function createSentenceChunker(opts: SentenceChunkerOptions = {}): SentenceChunker {
	const minChars = opts.minChars ?? 24
	const maxChars = opts.maxChars ?? 280
	let buf = ''

	function findCut(final: boolean): number {
		let i = 0
		while (i < buf.length) {
			const ch = buf.charAt(i)
			if (TERMINAL.has(ch)) {
				let end = i + 1
				while (end < buf.length && (TERMINAL.has(buf.charAt(end)) || CLOSERS.has(buf.charAt(end))))
					end++
				const next = buf[end]
				const atEnd = end >= buf.length
				if ((atEnd && final) || isWhitespace(next)) {
					const isDot = ch === '.' && end === i + 1
					if (
						!(isDot && endsWithAbbreviation(buf, end)) &&
						buf.slice(0, end).trim().length >= minChars
					) {
						return end
					}
				}
				i = end
				continue
			}
			if (ch === '\n') {
				if (buf.slice(0, i).trim().length >= minChars) return i
			}
			i++
		}
		if (final) return buf.trim().length > 0 ? buf.length : 0
		if (buf.length > maxChars) {
			const window = buf.slice(0, maxChars)
			const soft = Math.max(
				window.lastIndexOf(','),
				window.lastIndexOf(';'),
				window.lastIndexOf(':'),
			)
			if (soft >= minChars) return soft + 1
			const space = window.lastIndexOf(' ')
			if (space >= minChars) return space
			return maxChars
		}
		return 0
	}

	function drain(final: boolean): string[] {
		const out: string[] = []
		while (true) {
			const cut = findCut(final)
			if (cut <= 0) break
			const sentence = buf.slice(0, cut).trim()
			buf = buf.slice(cut)
			if (sentence) out.push(sentence)
			if (buf.length === 0) break
		}
		return out
	}

	return {
		push(delta) {
			buf += delta
			return drain(false)
		},
		flush() {
			const out = drain(true)
			buf = ''
			return out
		},
		pending: () => buf,
	}
}
