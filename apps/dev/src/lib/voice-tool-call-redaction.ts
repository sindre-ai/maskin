/**
 * Redaction and size caps for the voice tool call log (voice_tool_calls).
 *
 * The log exists so support can see what the model sent and what came back.
 * It must not become a second copy of customer content, so it keeps ids, short
 * strings and lengths, and drops or elides the rest:
 *
 *   - a key that looks like a secret (token, password, api key, authorization,
 *     cookie, ...) keeps no value at all
 *   - a key that carries content (body, text, message, html, data, ...) keeps
 *     only its length
 *   - every other string is cut at STRING_CAP chars
 *   - a string that looks like a credential, or an email address, is masked
 *     wherever it appears
 *   - depth, array length, key count and total size are bounded
 */

export const STRING_CAP = 200
export const MAX_DEPTH = 4
export const MAX_ARRAY_ITEMS = 10
export const MAX_OBJECT_KEYS = 30
export const ARGS_SUMMARY_CAP_CHARS = 4_000
export const OUTPUT_PREVIEW_CHARS = 500
export const ERROR_MESSAGE_CHARS = 500

const REDACTED = '[redacted]'

/** Keys compared lower-cased with punctuation stripped, so api_key, apiKey and API-KEY agree. */
const SECRET_KEY_PARTS = [
	'secret',
	'token',
	'password',
	'passwd',
	'passphrase',
	'apikey',
	'privatekey',
	'accesskey',
	'authorization',
	'credential',
	'cookie',
	'bearer',
	'signature',
]

const CONTENT_KEY_RE =
	/^(body|content|contents|text|message|messages|html|markdown|data|base64|blob|transcript|prompt|description|summary|notes|note|bio|snippet|reply|draft|email_body|body_text)$/

function isSecretKey(key: string): boolean {
	const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
	if (k === 'auth') return true
	return SECRET_KEY_PARTS.some((part) => k.includes(part))
}

function isContentKey(key: string): boolean {
	return CONTENT_KEY_RE.test(key.toLowerCase().replace(/[-\s]/g, '_'))
}

const VALUE_SECRET_RES: RegExp[] = [
	/\bank_[A-Za-z0-9]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
]
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** "token": "abc" inside text that is not (valid) JSON. */
const KEYED_SECRET_RE =
	/("?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[A-Za-z0-9_-]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi

/** Masks credentials and email addresses inside a string. Does not cut it. */
export function maskSensitiveText(text: string): string {
	let out = text
	for (const re of VALUE_SECRET_RES) out = out.replace(re, REDACTED)
	out = out.replace(KEYED_SECRET_RE, (_m, lead: string) => `${lead}"${REDACTED}"`)
	return out.replace(EMAIL_RE, '[email]')
}

function capString(text: string, cap: number): string {
	const masked = maskSensitiveText(text)
	return masked.length > cap ? `${masked.slice(0, cap)}…[+${masked.length - cap} chars]` : masked
}

function redactInner(value: unknown, depth: number, stringCap: number): unknown {
	if (value === null || value === undefined) return null
	if (typeof value === 'string') return capString(value, stringCap)
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return value.toString()
	if (depth >= MAX_DEPTH) {
		return Array.isArray(value) ? `[array of ${value.length}]` : '[object]'
	}
	if (Array.isArray(value)) {
		const items = value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => redactInner(item, depth + 1, stringCap))
		if (value.length > MAX_ARRAY_ITEMS) items.push(`…[+${value.length - MAX_ARRAY_ITEMS} items]`)
		return items
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
		const out: Record<string, unknown> = {}
		for (const [key, v] of entries.slice(0, MAX_OBJECT_KEYS)) {
			if (isSecretKey(key)) {
				out[key] = REDACTED
			} else if (isContentKey(key) && typeof v === 'string') {
				out[key] = `[${v.length} chars]`
			} else if (isContentKey(key) && v !== null && typeof v === 'object') {
				out[key] = Array.isArray(v) ? `[array of ${v.length}]` : '[object]'
			} else {
				out[key] = redactInner(v, depth + 1, stringCap)
			}
		}
		if (entries.length > MAX_OBJECT_KEYS) {
			out._more_keys = entries.length - MAX_OBJECT_KEYS
		}
		return out
	}
	return String(value)
}

/** Redacts and caps any JSON-like value. Never throws. */
export function redactValue(value: unknown, stringCap = STRING_CAP): unknown {
	try {
		return redactInner(value, 0, stringCap)
	} catch {
		return '[unreadable]'
	}
}

/** The arguments the model sent, redacted, and small enough to store. */
export function summarizeToolArgs(args: unknown): unknown {
	const redacted = redactValue(args)
	let size: number
	try {
		size = JSON.stringify(redacted)?.length ?? 0
	} catch {
		return { _unreadable: true }
	}
	if (size <= ARGS_SUMMARY_CAP_CHARS) return redacted
	const keys =
		redacted && typeof redacted === 'object' && !Array.isArray(redacted)
			? Object.keys(redacted as object).slice(0, MAX_OBJECT_KEYS)
			: []
	return { _truncated: true, chars: size, keys }
}

const CONTENT_FIELD_RE =
	/("(?:body|content|contents|text|message|html|markdown|data|base64|transcript|prompt|description|summary|notes|bio|snippet|reply|draft)"\s*:\s*)"(?:[^"\\]|\\.)*(?:"|$)/gi

/** Replaces the string value of content-bearing JSON fields in text that may not parse. */
function elideContentFields(text: string): string {
	return text.replace(CONTENT_FIELD_RE, '$1"[elided]"')
}

/**
 * The start of what the model was told, redacted the same way. A JSON output is
 * parsed and redacted structurally (so a "content" field keeps only its length);
 * anything else is masked as text. Cut at OUTPUT_PREVIEW_CHARS.
 */
export function previewToolOutput(output: string): string {
	let text: string
	try {
		const parsed: unknown = JSON.parse(output)
		if (parsed !== null && typeof parsed === 'object') {
			text = JSON.stringify(redactValue(parsed, 120))
		} else {
			text = maskSensitiveText(output)
		}
	} catch {
		// Not JSON, or JSON that voice's cap cut off. Elide content fields by pattern instead.
		text = maskSensitiveText(elideContentFields(output))
	}
	return text.length > OUTPUT_PREVIEW_CHARS ? text.slice(0, OUTPUT_PREVIEW_CHARS) : text
}

export function capErrorMessage(message: string | null | undefined): string | null {
	if (!message) return null
	const masked = maskSensitiveText(message)
	return masked.length > ERROR_MESSAGE_CHARS ? masked.slice(0, ERROR_MESSAGE_CHARS) : masked
}
