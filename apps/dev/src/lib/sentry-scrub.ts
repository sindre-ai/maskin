import type { Breadcrumb, ErrorEvent, Log } from '@sentry/node'

// Everything apps/dev sends to Sentry (Logs, events, breadcrumbs) passes through
// these hooks first, wired in sentry.ts. They remove bound SQL values from error
// text: drizzle-orm builds "Failed query: <sql>\nparams: <every bound value>", so a
// failed write that binds a token or hash would otherwise ship the value.
// Only string values are rewritten, keys never are, and stdout is never touched
// (the logger prints before anything here runs).

const MAX_DEPTH = 5
const REDACTED = '[redacted]'
const DRIZZLE_QUERY_MARKER = 'Failed query:'
const DRIZZLE_PARAMS_MARKER = '\nparams:'
// Sentry's console integration records every console line as a breadcrumb with this category.
const CONSOLE_CATEGORY = 'console'

// Postgres detail text, e.g. Key (email)=(a@b.c) already exists. The value can
// itself contain ")", so anchor on the known endings first and fall back to the
// first ")" rather than leaving a tail of the value behind.
const PG_KEY_DETAIL_ANCHORED =
	/(Key \([^)]*\)=\()[\s\S]*?(\)(?: already exists| is not present| is still referenced| conflicts with|\.?$))/g
const PG_KEY_DETAIL_LOOSE = /(Key \([^)]*\)=\()[^)]*(\))/g

/**
 * Rule 1: keep the SQL text (placeholders only), drop everything from the
 * "params:" line to the end of the string. Both markers are required, so an
 * unrelated "params:" is left alone. Param values can contain commas and
 * newlines, so there is no safe end marker short of the end of the string.
 * Rule 2: blank the value in Postgres "Key (col)=(value)" detail text.
 * Returns the same reference when nothing matched.
 */
export function scrubString(input: string): string {
	let out = input
	const queryAt = out.indexOf(DRIZZLE_QUERY_MARKER)
	if (queryAt !== -1) {
		const paramsAt = out.indexOf(DRIZZLE_PARAMS_MARKER, queryAt)
		if (paramsAt !== -1) out = `${out.slice(0, paramsAt)}${DRIZZLE_PARAMS_MARKER} ${REDACTED}`
	}
	if (out.includes('Key (')) {
		out = out.replace(PG_KEY_DETAIL_ANCHORED, `$1${REDACTED}$2`)
		out = out.replace(PG_KEY_DETAIL_LOOSE, `$1${REDACTED}$2`)
	}
	return out === input ? input : out
}

function isPlainObject(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * Deep copy with every string scrubbed. Never mutates the input (the logger passes
 * the caller's own context object). Error objects are reduced to name, message,
 * stack and cause, which drops own props such as drizzle's raw params array.
 * Containers nested deeper than MAX_DEPTH are replaced rather than passed through.
 */
export function scrubDeep(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return scrubString(value)
	if (value === null || typeof value !== 'object') return value
	if (depth >= MAX_DEPTH) return '[truncated]'
	if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1))
	if (value instanceof Error) {
		return {
			name: value.name,
			message: scrubString(value.message),
			stack: typeof value.stack === 'string' ? scrubString(value.stack) : undefined,
			cause: value.cause === undefined ? undefined : scrubDeep(value.cause, depth + 1),
		}
	}
	if (!isPlainObject(value)) return value
	const out: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, depth + 1)
	// An Error that Sentry already normalized into a plain object (event.extra) keeps
	// drizzle's raw bound values in params, and those strings carry no marker to match.
	if (typeof out.query === 'string' && Array.isArray(out.params)) out.params = REDACTED
	return out
}

function scrubRecord(value: Record<string, unknown> | undefined) {
	return value === undefined ? undefined : (scrubDeep(value) as Record<string, unknown>)
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
	return {
		...crumb,
		message: crumb.message === undefined ? undefined : scrubString(crumb.message),
		data: scrubRecord(crumb.data),
	}
}

export function scrubLog(log: Log): Log | null {
	try {
		return {
			...log,
			message: scrubString(log.message),
			attributes: scrubRecord(log.attributes),
		}
	} catch {
		// Never fall back to the unscrubbed log.
		return null
	}
}

// Console breadcrumbs are dropped, not scrubbed: they hold the logger's JSON stdout
// line (and the raw arguments), where the newline before params is an escaped
// backslash-n and an Error context is serialized with its raw params array, so
// no string rule matches reliably. logger.warn adds its own scrubbed breadcrumb,
// and Sentry Logs carry info and warn, so nothing the team reads is lost.
export function scrubBreadcrumbHook(crumb: Breadcrumb): Breadcrumb | null {
	try {
		if (crumb.category === CONSOLE_CATEGORY) return null
		return scrubBreadcrumb(crumb)
	} catch {
		return null
	}
}

export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
	try {
		return {
			...event,
			message: event.message === undefined ? undefined : scrubString(event.message),
			extra: scrubRecord(event.extra),
			exception: event.exception && {
				...event.exception,
				// cause and linked errors arrive as separate entries in values
				values: event.exception.values?.map((entry) => ({
					...entry,
					value: entry.value === undefined ? undefined : scrubString(entry.value),
				})),
			},
			breadcrumbs: event.breadcrumbs
				?.filter((crumb) => crumb.category !== CONSOLE_CATEGORY)
				.map(scrubBreadcrumb),
		}
	} catch {
		// Never fall back to the unscrubbed event: send it without any free text.
		try {
			return {
				...event,
				message: undefined,
				extra: undefined,
				breadcrumbs: undefined,
				exception: event.exception && {
					...event.exception,
					values: event.exception.values?.map((entry) => ({ ...entry, value: undefined })),
				},
			}
		} catch {
			return null
		}
	}
}
