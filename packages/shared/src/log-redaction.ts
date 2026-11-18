// Masks secrets in text before it is stored in a session log. Shared by the dev server
// (session_logs) and the agent-server (guest console lines), so both use one set of rules.

const REDACTED = '[REDACTED]'

/**
 * Token-shaped strings, recognised by their prefix or structure alone. Matched wherever they
 * appear (log prose, JSON, argv dumps). Replacing one inside a JSON string keeps the JSON valid.
 */
export const TOKEN_SHAPE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
	[/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
	[/\bsk-ant-[A-Za-z0-9._-]{16,}/g, REDACTED],
	[/\bsk-[A-Za-z0-9]{20,}/g, REDACTED],
	[/\bank_[A-Za-z0-9]{16,}/g, REDACTED],
	[/\b(?:mat|mrt)_[A-Za-z0-9_-]{16,}/g, REDACTED],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
	// JWTs (Anthropic OAuth, GitHub App installation tokens, MCP bearer tokens).
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
]

/** Replace token-shaped substrings. Leaves everything else, including JSON structure, as it was. */
export function redactTokenShapes(text: string): string {
	let out = text
	for (const [pattern, replacement] of TOKEN_SHAPE_REDACTIONS) {
		out = out.replace(pattern, replacement)
	}
	return out
}

/** A value shorter than this is never masked: it would eat ordinary text. */
export const KEYCHAIN_MASK_MIN_VALUE_LENGTH = 8

/** For a multi-line secret, a line of this length or more is masked on its own. */
export const KEYCHAIN_MASK_MIN_LINE_LENGTH = 16

const PEM_BOUNDARY = /^-----(?:BEGIN|END)/

/** How many times a value may sit inside JSON text that is itself inside a JSON string. */
const JSON_ESCAPE_DEPTH = 2

function jsonEscape(s: string): string {
	return JSON.stringify(s).slice(1, -1)
}

/**
 * Every spelling of `value` a log line can hold: the raw text, the whole value as one
 * piece, and, for a multi-line secret, each long line and each PEM boundary line on its own.
 * Each one also appears JSON-escaped (stdout is stream-json, so a printed key carries `\n`
 * escapes), and escaped again for JSON inside a JSON string.
 */
function spellingsOf(value: string): string[] {
	const pieces = new Set<string>([value])
	if (/[\r\n]/.test(value)) {
		for (const raw of value.split(/\r?\n/)) {
			const line = raw.trim()
			if (line.length >= KEYCHAIN_MASK_MIN_LINE_LENGTH || PEM_BOUNDARY.test(line)) pieces.add(line)
		}
	}
	const all = new Set<string>()
	for (const piece of pieces) {
		let form = piece
		for (let depth = 0; depth <= JSON_ESCAPE_DEPTH; depth++) {
			if (form) all.add(form)
			form = jsonEscape(form)
		}
	}
	return [...all]
}

/**
 * Build a function that swaps each given Keychain value for `[REDACTED · NAME]`, where NAME is
 * the env var that carried it. Returns null when nothing is long enough to mask. Never logs
 * or returns a value; the values live only in the closure.
 *
 * Longest spellings go first, so a whole key is replaced as one piece before its lines are.
 */
export function createKeychainMasker(
	secrets: Record<string, string>,
): ((text: string) => string) | null {
	const entries: Array<{ needle: string; placeholder: string }> = []
	const seen = new Set<string>()
	for (const [name, value] of Object.entries(secrets)) {
		if (typeof value !== 'string' || value.length < KEYCHAIN_MASK_MIN_VALUE_LENGTH) continue
		const placeholder = `[REDACTED · ${name}]`
		for (const needle of spellingsOf(value)) {
			if (seen.has(needle)) continue
			seen.add(needle)
			entries.push({ needle, placeholder })
		}
	}
	if (entries.length === 0) return null
	entries.sort((a, b) => b.needle.length - a.needle.length)
	return (text) => {
		let out = text
		for (const { needle, placeholder } of entries) {
			if (out.includes(needle)) out = out.split(needle).join(placeholder)
		}
		return out
	}
}
