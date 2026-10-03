import type { Breadcrumb, ErrorEvent, Log } from '@sentry/node'

// Scrubs bound SQL parameter values out of everything apps/dev sends to Sentry.
// drizzle-orm builds a failed-query error as "Failed query: <sql>\nparams: <every
// bound value>", so a failed write that binds a token or hash would otherwise ship
// the value. Wired into Sentry.init (sentry.ts) so logs, events and breadcrumbs are
// all covered. Only string values are touched, never keys; stdout is not scrubbed.

const MAX_DEPTH = 5
const REDACTED = '[redacted]'
const DRIZZLE_PREFIX = 'Failed query:'
const DRIZZLE_PARAMS = '\nparams:'

// Postgres detail text: Key (col)=(value) already exists. The value can itself
// contain ")", so match lazily up to the known detail terminators (or end of line).
const PG_KEY_DETAIL =
	/(Key \([^)]*\)=\()[\s\S]*?(\)(?= already exists| is not present| is still referenced| conflicts with|\.?(?:\r?\n|$)))/g

export function scrubString(input: string): string {
	let out = input
	const prefixAt = out.indexOf(DRIZZLE_PREFIX)
	if (prefixAt !== -1) {
		const paramsAt = out.indexOf(DRIZZLE_PARAMS, prefixAt)
		// Values can hold commas and newlines, so there is no safe end marker: cut to the end.
		if (paramsAt !== -1) out = `${out.slice(0, paramsAt)}${DRIZZLE_PARAMS} ${REDACTED}`
	}
	if (out.includes('Key (')) out = out.replace(PG_KEY_DETAIL, `$1${REDACTED}$2`)
	return out
}

function isPlainObject(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

// Copy-on-change: returns the same reference when nothing inside needed scrubbing,
// and never mutates the input (event.extra can be the caller's own context object).
export function scrubValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return scrubString(value)
	if (value === null || typeof value !== 'object') return value
	const isArray = Array.isArray(value)
	if (!isArray && !isPlainObject(value)) return value
	// Containers past the cap are dropped rather than sent unscrubbed.
	if (depth >= MAX_DEPTH) return '[truncated]'

	let changed = false
	if (isArray) {
		const out = value.map((item) => {
			const next = scrubValue(item, depth + 1)
			if (next !== item) changed = true
			return next
		})
		return changed ? out : value
	}
	const out: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		const next = scrubValue(item, depth + 1)
		if (next !== item) changed = true
		out[key] = next
	}
	return changed ? out : value
}

export function scrubLog(log: Log): Log | null {
	try {
		const message = String(log.message)
		const scrubbedMessage = scrubString(message)
		return {
			...log,
			...(scrubbedMessage !== message && { message: scrubbedMessage }),
			attributes: scrubValue(log.attributes) as Log['attributes'],
		}
	} catch {
		// Never fall back to the unscrubbed log.
		return null
	}
}

function scrubBreadcrumbFields(breadcrumb: Breadcrumb): Breadcrumb {
	return {
		...breadcrumb,
		message: breadcrumb.message === undefined ? undefined : scrubString(breadcrumb.message),
		data: scrubValue(breadcrumb.data) as Breadcrumb['data'],
	}
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
	try {
		return scrubBreadcrumbFields(breadcrumb)
	} catch {
		return null
	}
}

export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
	try {
		return {
			...event,
			message: event.message === undefined ? undefined : scrubString(event.message),
			extra: scrubValue(event.extra) as ErrorEvent['extra'],
			exception: event.exception && {
				...event.exception,
				// Cause and linked errors arrive as separate entries in values.
				values: event.exception.values?.map((entry) => ({
					...entry,
					value: entry.value === undefined ? undefined : scrubString(entry.value),
				})),
			},
			breadcrumbs: event.breadcrumbs?.map(scrubBreadcrumbFields),
		}
	} catch {
		// Never fall back to the unscrubbed event: drop every free-text field we could not scrub.
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
	}
}
