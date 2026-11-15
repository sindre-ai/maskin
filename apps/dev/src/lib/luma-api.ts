const LUMA_API = 'https://public-api.luma.com/v1'
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 100
/** A guard against a cursor that never ends; far above any real guest list. */
const MAX_PAGES = 500

/** Luma answered with an error. `retryAfterSeconds` is set on a 429. */
export class LumaApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly retryAfterSeconds: number | null = null,
	) {
		super(message)
		this.name = 'LumaApiError'
	}
}

export interface LumaCalendarEvent {
	id: string
	url: string
}

/** The guest's approval status, as Luma names it. Anything else is counted under its own name. */
export type LumaApprovalStatus =
	| 'approved'
	| 'pending_approval'
	| 'waitlist'
	| 'invited'
	| 'declined'
	| 'session'

interface Page<T> {
	entries?: T[]
	has_more?: boolean
	next_cursor?: string
}

async function lumaGet<T>(
	apiKey: string,
	path: string,
	params: Record<string, string>,
	fetchFn: typeof fetch,
): Promise<Page<T>> {
	const url = new URL(`${LUMA_API}${path}`)
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
	const res = await fetchFn(url, {
		headers: { 'x-luma-api-key': apiKey },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok) {
		const retryAfter = Number(res.headers.get('retry-after'))
		throw new LumaApiError(
			res.status,
			`Luma answered ${res.status} for ${path}`,
			res.status === 429 && Number.isFinite(retryAfter) ? retryAfter : null,
		)
	}
	return (await res.json()) as Page<T>
}

/** Every page of a cursor-paged list. A failed page throws, so a partial list is never mistaken for the whole. */
async function lumaAll<T>(
	apiKey: string,
	path: string,
	params: Record<string, string>,
	fetchFn: typeof fetch,
): Promise<T[]> {
	const out: T[] = []
	let cursor: string | undefined
	for (let page = 0; page < MAX_PAGES; page++) {
		const body = await lumaGet<T>(
			apiKey,
			path,
			{
				...params,
				pagination_limit: String(PAGE_LIMIT),
				...(cursor ? { pagination_cursor: cursor } : {}),
			},
			fetchFn,
		)
		out.push(...(body.entries ?? []))
		if (!body.has_more || !body.next_cursor) return out
		cursor = body.next_cursor
	}
	throw new Error(`Luma list ${path} did not end after ${MAX_PAGES} pages`)
}

/** The events the calendar manages, with the public page URL each one has. */
export async function listCalendarEvents(
	apiKey: string,
	fetchFn: typeof fetch = fetch,
): Promise<LumaCalendarEvent[]> {
	const raw = await lumaAll<{ id?: unknown; url?: unknown }>(
		apiKey,
		'/calendars/events/list',
		{},
		fetchFn,
	)
	const out: LumaCalendarEvent[] = []
	for (const e of raw) {
		if (typeof e.id === 'string' && typeof e.url === 'string') out.push({ id: e.id, url: e.url })
	}
	return out
}

/**
 * How many guests the event has under each approval status. There is no count endpoint,
 * so this pages through the whole guest list and counts.
 */
export async function countGuestsByStatus(
	apiKey: string,
	eventId: string,
	fetchFn: typeof fetch = fetch,
): Promise<Record<string, number>> {
	const guests = await lumaAll<{ approval_status?: unknown }>(
		apiKey,
		'/events/guests/list',
		{ event_id: eventId },
		fetchFn,
	)
	const counts: Record<string, number> = {}
	for (const g of guests) {
		const status = typeof g.approval_status === 'string' ? g.approval_status : 'unknown'
		counts[status] = (counts[status] ?? 0) + 1
	}
	return counts
}

/** `luma.com/<slug>` and `lu.ma/<slug>` are the same page. Null when it is not a Luma page URL. */
export function lumaSlug(raw: string): string | null {
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		return null
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, '')
	if (host !== 'luma.com' && host !== 'lu.ma') return null
	const slug = url.pathname.split('/').filter(Boolean)[0]
	return slug ? slug.toLowerCase() : null
}

const LUMA_URL_RE = /https?:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^\s)\]>"']+/gi

/** The first Luma page URL the event carries: in its metadata, else in its text. */
export function findLumaListingUrl(
	metadata: Record<string, unknown> | null,
	content: string | null,
): string | null {
	for (const v of Object.values(metadata ?? {})) {
		if (typeof v === 'string' && lumaSlug(v)) return v.trim()
	}
	for (const m of (content ?? '').matchAll(LUMA_URL_RE)) {
		// Trailing sentence punctuation is not part of the URL.
		const candidate = m[0].replace(/[.,;:!?]+$/, '')
		if (lumaSlug(candidate)) return candidate
	}
	return null
}
