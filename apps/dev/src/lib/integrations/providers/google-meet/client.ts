import { logger } from '../../../logger'
import { MeetError, classifyGoogleError } from './errors'

/**
 * HTTP client for the Google Meet REST v2 API + the calendar.events.insert
 * side-channel needed for `create_meet_backed_event`. Interface, not tight
 * coupling — the operations layer only depends on the shape below, so tests
 * inject a fake and swapping to `google-auth-library` down the road is a
 * one-file rewrite.
 *
 * Retries + backoff live here, per the write-path task's error taxonomy:
 *   - 429 / 5xx → exponential backoff (base 500ms, ±25% jitter, cap 8s),
 *     max 5 attempts. After that, `classifyGoogleError` raises
 *     RATE_LIMITED or PROVIDER_ERROR.
 *   - 4xx (other than 429) → immediate throw, no retry.
 *
 * All non-2xx responses become a MeetError via classifyGoogleError. The
 * operations layer never sees a raw HTTP status.
 */

const MEET_API_BASE = 'https://meet.googleapis.com/v2'
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 8_000
const BACKOFF_MAX_ATTEMPTS = 5
const BACKOFF_JITTER = 0.25

export interface GoogleMeetClient {
	/**
	 * Meet API v2 `spaces.create`. `body` is the SpaceConfig payload; empty
	 * object provisions a space with Meet's defaults.
	 */
	createSpace(accessToken: string, body: unknown): Promise<CreateSpaceResponse>

	/**
	 * Calendar API `events.insert` with `conferenceDataVersion=1` — the query
	 * param without which GCal silently drops any `conferenceData.createRequest`
	 * on the body. See bug ac295f51 root cause; the write-path tool sets it
	 * unconditionally.
	 */
	insertCalendarEvent(
		accessToken: string,
		params: { calendarId: string; sendUpdates?: string; body: unknown },
	): Promise<CalendarEventResponse>
}

/**
 * Minimal shape returned by Meet's spaces.create — matches the fields the
 * write-path tool surfaces to the agent. Full response has more (config,
 * activeConference, moderation, etc.) — kept `unknown`-typed at the client
 * boundary so we don't have to re-declare the whole Meet SDK.
 */
export interface CreateSpaceResponse {
	name: string
	meetingUri: string
	meetingCode: string
	config?: unknown
	activeConference?: unknown
	moderation?: unknown
	moderationRestrictions?: unknown
}

/**
 * The fields the write-path tool needs off a Calendar Event response. GCal
 * returns much more; keeping the interface tight makes the tool's `event`
 * output stable if Google adds new fields.
 */
export interface CalendarEventResponse {
	id: string
	summary?: string
	hangoutLink?: string
	htmlLink?: string
	conferenceData?: {
		conferenceId?: string
		conferenceSolution?: { key?: { type?: string }; name?: string }
		entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>
		createRequest?: { requestId?: string; status?: { statusCode?: string } }
	}
	start?: unknown
	end?: unknown
	attendees?: unknown
	organizer?: { email?: string; displayName?: string }
	status?: string
	[key: string]: unknown
}

export function createDefaultGoogleMeetClient(fetchImpl: typeof fetch = fetch): GoogleMeetClient {
	return {
		async createSpace(accessToken, body) {
			const url = `${MEET_API_BASE}/spaces`
			const res = await requestWithRetry(fetchImpl, {
				url,
				method: 'POST',
				accessToken,
				body: JSON.stringify(body ?? {}),
				operation: 'meet.spaces.create',
			})
			return (await parseJson<CreateSpaceResponse>(res)) as CreateSpaceResponse
		},
		async insertCalendarEvent(accessToken, params) {
			const qs = new URLSearchParams()
			qs.set('conferenceDataVersion', '1')
			if (params.sendUpdates) qs.set('sendUpdates', params.sendUpdates)
			const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events?${qs.toString()}`
			const res = await requestWithRetry(fetchImpl, {
				url,
				method: 'POST',
				accessToken,
				body: JSON.stringify(params.body ?? {}),
				operation: 'calendar.events.insert',
			})
			return (await parseJson<CalendarEventResponse>(res)) as CalendarEventResponse
		},
	}
}

interface RequestArgs {
	url: string
	method: 'POST' | 'GET' | 'PATCH'
	accessToken: string
	body?: string
	operation: string
}

async function requestWithRetry(fetchImpl: typeof fetch, args: RequestArgs): Promise<Response> {
	let lastError: unknown
	for (let attempt = 1; attempt <= BACKOFF_MAX_ATTEMPTS; attempt++) {
		let res: Response
		try {
			res = await fetchImpl(args.url, {
				method: args.method,
				headers: {
					Authorization: `Bearer ${args.accessToken}`,
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: args.body,
			})
		} catch (err) {
			// Network-level error (DNS, TCP RST, aborted) — retry with the same
			// budget as a 5xx, since these have the same "transient upstream"
			// character. Terminal after the loop.
			lastError = err
			if (attempt < BACKOFF_MAX_ATTEMPTS) {
				await sleep(computeBackoff(attempt))
				continue
			}
			logger.warn('Google Meet API network failure exhausted retries', {
				operation: args.operation,
				attempts: attempt,
				error: String(err),
			})
			throw new MeetError({
				code: 'PROVIDER_ERROR',
				message: `Network failure calling ${args.operation} after ${attempt} attempts.`,
				provider_status: 0,
			})
		}

		if (res.status >= 200 && res.status < 300) return res

		// 429 + 5xx = retry class; 4xx = terminal.
		const isRetryable = res.status === 429 || res.status >= 500
		if (isRetryable && attempt < BACKOFF_MAX_ATTEMPTS) {
			const bodyPeek = await peekBody(res)
			logger.info('Google Meet API retryable status, backing off', {
				operation: args.operation,
				status: res.status,
				attempt,
				bodyPreview: bodyPeek.slice(0, 200),
			})
			const retryAfterMs = readRetryAfterMs(res.headers.get('retry-after'))
			await sleep(retryAfterMs ?? computeBackoff(attempt))
			continue
		}

		// Terminal: classify and throw. The classifier reads the body; we buffer
		// it once so both classify() and the MeetError message can use it.
		const bodyText = await res.text()
		let body: unknown
		try {
			body = JSON.parse(bodyText)
		} catch {
			body = undefined
		}
		throw classifyGoogleError({
			status: res.status,
			bodyText,
			body,
			retryAfterHeader: res.headers.get('retry-after'),
		})
	}
	// Unreachable — the loop either returns a 2xx or throws in the terminal
	// branch. Included for exhaustiveness so an editor tool that folds the
	// control flow doesn't drop the throw type.
	throw new MeetError({
		code: 'PROVIDER_ERROR',
		message: `Exhausted retries calling ${args.operation}: ${String(lastError)}`,
		provider_status: 0,
	})
}

async function parseJson<T>(res: Response): Promise<T> {
	const text = await res.text()
	if (!text) return {} as T
	try {
		return JSON.parse(text) as T
	} catch (err) {
		logger.warn('Google Meet API returned non-JSON on 2xx', {
			status: res.status,
			bodyPreview: text.slice(0, 200),
		})
		throw new MeetError({
			code: 'PROVIDER_ERROR',
			message: 'Google returned a 2xx response with an unparseable body.',
			provider_status: res.status,
		})
	}
}

async function peekBody(res: Response): Promise<string> {
	try {
		// Response body can only be consumed once; clone so the terminal branch
		// can still classify off it if this retry attempt is the last.
		return await res.clone().text()
	} catch {
		return ''
	}
}

function computeBackoff(attempt: number): number {
	const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
	const jitter = exp * BACKOFF_JITTER * (Math.random() * 2 - 1)
	return Math.max(0, Math.round(exp + jitter))
}

function readRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined
	const asNumber = Number(header)
	if (Number.isFinite(asNumber) && asNumber >= 0) return Math.min(asNumber * 1000, BACKOFF_MAX_MS * 2)
	return undefined
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}
