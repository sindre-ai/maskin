import { type DataQueryResult, dataQueryResultSchema } from '@maskin/shared'

// The last answer to each query a loop's custom view asked for, kept in this browser so the
// next visit can draw the view at once and refresh behind it. An answer is only ever a
// starting picture: the host always asks the server again and replaces it.

const PREFIX = 'maskin-loop-view:'
/** An answer older than this is not worth showing first; the view waits for a live one. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface CachedResult {
	result: DataQueryResult
	/** When the answer was fetched, in epoch ms. */
	at: number
}

function storageKey(workspaceId: string, queryKey: string) {
	return `${PREFIX}${workspaceId}:${queryKey}`
}

export function readCachedResult(workspaceId: string, queryKey: string): CachedResult | null {
	try {
		const raw = localStorage.getItem(storageKey(workspaceId, queryKey))
		if (!raw) return null
		const parsed = JSON.parse(raw) as { at?: unknown; result?: unknown } | null
		if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > MAX_AGE_MS) return null
		const result = dataQueryResultSchema.safeParse(parsed.result)
		return result.success ? { result: result.data, at: parsed.at } : null
	} catch {
		return null
	}
}

/** Saves a fresh answer and returns the time it was stamped with. A full or blocked store just means no cache. */
export function writeCachedResult(
	workspaceId: string,
	queryKey: string,
	result: DataQueryResult,
): number {
	const at = Date.now()
	try {
		localStorage.setItem(storageKey(workspaceId, queryKey), JSON.stringify({ at, result }))
	} catch {
		// Not being able to cache must never break the view.
	}
	return at
}

export function dropCachedResult(workspaceId: string, queryKey: string) {
	try {
		localStorage.removeItem(storageKey(workspaceId, queryKey))
	} catch {
		// Nothing to drop if the store is unavailable.
	}
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 4 -> 4th, 11 -> 11th, 21 -> 21st. */
function ordinal(day: number): string {
	if (day >= 11 && day <= 13) return `${day}th`
	const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th'
	return `${day}${suffix}`
}

/** `4th Nov 09:05` in the viewer's own time zone. */
export function formatUpdatedAt(epochMs: number): string {
	const d = new Date(epochMs)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
