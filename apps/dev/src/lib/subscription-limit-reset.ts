/**
 * Parses the "when will this Claude subscription accept requests again?" signal
 * from every place we see it: the Anthropic `anthropic-ratelimit-unified-reset`
 * header, an HTTP `retry-after` header, a Claude CLI stdout banner, and a
 * remote /complete callback carrying `retry_after_seconds`.
 *
 * Pure function — no DB, no clock beyond `now`. The caller (§17.5 companion
 * parser at each classifier call-site) folds the result onto its
 * ClassifierDecision.retryAt, which settleSession writes to sessions.retry_at.
 *
 * Source precedence (§17.2): 1 authoritative pre-flight → 2 header on the failed
 * request → 4 remote callback → 3 CLI banner tail. See parseSubscriptionLimitReset.
 *
 * Clamp bounds (§17.3): resetAt ∈ [now+60s, now+24h]. Outside → null. This is
 * defence in depth against a bad clock or a hostile input pushing a session's
 * retry either infinitely soon (thrash) or infinitely far (never).
 */

const MIN_RETRY_MS = 60_000
const MAX_RETRY_MS = 24 * 60 * 60 * 1000

export type SubscriptionLimitResetSource =
	| 'anthropic-ratelimit-unified-reset'
	| 'retry-after-header'
	| 'cli-banner'
	| 'agent-server-callback'

export type SubscriptionLimitResetConfidence = 'authoritative' | 'advisory'

export interface SubscriptionLimitReset {
	resetAt: Date
	source: SubscriptionLimitResetSource
	confidence: SubscriptionLimitResetConfidence
}

export interface SubscriptionLimitResetInput {
	anthropicHeaders?: Record<string, string | undefined>
	cliStdoutTail?: string
	callbackRetryAfterSeconds?: number | null
	now?: () => number
}

/**
 * Try the four signals in precedence order (§17.2) and return the first that
 * clamps into [now+60s, now+24h]. Every source that fails to parse or clamps
 * out is skipped; the walk continues.
 */
export function parseSubscriptionLimitReset(
	input: SubscriptionLimitResetInput,
): SubscriptionLimitReset | null {
	const nowMs = (input.now ?? Date.now)()
	const headers = normaliseHeaders(input.anthropicHeaders)

	// Source 1 in §17.2 is a `resolveClaudeSubscriptionCredentials` pre-flight
	// probe hit — the caller decides that context and passes it via headers on
	// the failed probe response. Source 2 is the same header on the failed
	// completion. Both use the same regex; the distinction is `confidence`,
	// which the caller stamps because only it knows whether the probe was
	// pre-flight (authoritative) or on a session-live path (advisory).
	const unifiedReset = headers.get('anthropic-ratelimit-unified-reset')
	const unifiedResetAt = parseAnthropicResetHeader(unifiedReset, nowMs)
	if (unifiedResetAt !== null) {
		return {
			resetAt: new Date(unifiedResetAt),
			source: 'anthropic-ratelimit-unified-reset',
			// Authoritative when the value is a fresh header from Anthropic; the
			// caller can downgrade via SubscriptionLimitReset.confidence if it
			// knows the header came from a stale cache.
			confidence: 'authoritative',
		}
	}

	const retryAfter = headers.get('retry-after')
	const retryAfterAt = parseRetryAfterHeader(retryAfter, nowMs)
	if (retryAfterAt !== null) {
		return {
			resetAt: new Date(retryAfterAt),
			source: 'retry-after-header',
			confidence: 'authoritative',
		}
	}

	if (input.callbackRetryAfterSeconds != null && Number.isFinite(input.callbackRetryAfterSeconds)) {
		const callbackAt = clamp(nowMs + input.callbackRetryAfterSeconds * 1000, nowMs)
		if (callbackAt !== null) {
			return {
				resetAt: new Date(callbackAt),
				source: 'agent-server-callback',
				confidence: 'advisory',
			}
		}
	}

	if (input.cliStdoutTail) {
		const bannerAt = parseCliBannerTail(input.cliStdoutTail, nowMs)
		if (bannerAt !== null) {
			return {
				resetAt: new Date(bannerAt),
				source: 'cli-banner',
				confidence: 'advisory',
			}
		}
	}

	return null
}

function normaliseHeaders(
	record: Record<string, string | undefined> | undefined,
): Map<string, string> {
	const map = new Map<string, string>()
	if (!record) return map
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === 'string' && value.length > 0) {
			map.set(key.toLowerCase(), value)
		}
	}
	return map
}

/**
 * Anthropic's `anthropic-ratelimit-unified-reset` ships either an ISO-8601
 * timestamp (`2026-09-29T21:30:00Z`) or a Unix epoch integer (seconds), per
 * the field's spec. Accept both and clamp.
 */
function parseAnthropicResetHeader(raw: string | undefined, nowMs: number): number | null {
	if (!raw) return null
	const trimmed = raw.trim()
	if (trimmed.length === 0) return null

	// Epoch seconds (10 digits today, 11 if we survive to the year 5138). Reject
	// anything with a decimal — Anthropic emits integers.
	if (/^\d{10,11}$/.test(trimmed)) {
		return clamp(Number(trimmed) * 1000, nowMs)
	}

	const parsed = Date.parse(trimmed)
	if (Number.isNaN(parsed)) return null
	return clamp(parsed, nowMs)
}

/**
 * RFC 7231 `Retry-After`: either delta-seconds or an HTTP-date. Anthropic sends
 * delta-seconds on 429 today; parse both to future-proof.
 */
function parseRetryAfterHeader(raw: string | undefined, nowMs: number): number | null {
	if (!raw) return null
	const trimmed = raw.trim()
	if (trimmed.length === 0) return null

	if (/^\d+$/.test(trimmed)) {
		return clamp(nowMs + Number(trimmed) * 1000, nowMs)
	}
	const parsed = Date.parse(trimmed)
	if (Number.isNaN(parsed)) return null
	return clamp(parsed, nowMs)
}

/**
 * CLI banner tail regex (§7.4). Matches the "Resets ..." fragment the Claude
 * Code CLI prints on rate-limit banners:
 *   "You've hit your limit · resets 2:30pm (UTC)"
 *   "Resets Jan 3 10am"
 *   "Resets Fri 09:15"
 *
 * The parse is best-effort — we resolve the fragment against `nowMs` in UTC and
 * clamp. A cleaner API would be to have the CLI emit ISO-8601 directly, but
 * until it does this is the only signal the local path has when the failover
 * header is not on the response body.
 */
export function parseCliResetBanner(stdoutTail: string, nowMs: number = Date.now()): Date | null {
	const parsed = parseCliBannerTail(stdoutTail, nowMs)
	return parsed === null ? null : new Date(parsed)
}

function parseCliBannerTail(tail: string, nowMs: number): number | null {
	// Two shapes: the "resets <time>" fragment inside the "You've hit your limit"
	// banner, or a bare "Resets <time>" line. Match either.
	const bannerMatch = /Resets?\s+([A-Za-z0-9 :\-,]+?)(?:\s*\(([A-Z]{2,5})\))?(?:$|[.\n])/i.exec(
		tail,
	)
	if (!bannerMatch) return null
	const rawCapture = bannerMatch[1]
	if (!rawCapture) return null
	const raw = rawCapture.trim()
	const tz = (bannerMatch[2] ?? 'UTC').toUpperCase()

	const resolved = resolveBannerFragment(raw, tz, nowMs)
	if (resolved === null) return null
	return clamp(resolved, nowMs)
}

/**
 * Resolve a banner fragment like "2:30pm" or "Jan 3 10am" or "Fri 09:15" into
 * absolute epoch milliseconds. The banner rarely names a year — Anthropic emits
 * short forms — so anchor against the current UTC date/week.
 */
function resolveBannerFragment(fragment: string, tz: string, nowMs: number): number | null {
	// Only handle UTC anchoring here. A future spec-widening pass can teach the
	// helper US timezones; for now every non-UTC banner is punted to null so we
	// don't confidently mis-schedule a retry.
	if (tz !== 'UTC' && tz !== 'GMT') return null

	// Try HH:MM(am|pm)? absolute time on today (UTC).
	const timeMatch = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(fragment)
	if (timeMatch) {
		return anchorTimeOfDay(timeMatch, nowMs)
	}

	// "Jan 3 10am" style — month/day + time
	const monthMatch = /^([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/.exec(
		fragment,
	)
	if (monthMatch) {
		return anchorMonthDay(monthMatch, nowMs)
	}

	// "Fri 09:15" — weekday + time
	const weekdayMatch = /^([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/.exec(fragment)
	if (weekdayMatch) {
		return anchorWeekday(weekdayMatch, nowMs)
	}

	return null
}

function anchorTimeOfDay(match: RegExpExecArray, nowMs: number): number | null {
	let hours = Number(match[1])
	const minutes = match[2] ? Number(match[2]) : 0
	const meridiem = match[3]?.toLowerCase()
	if (meridiem === 'pm' && hours < 12) hours += 12
	if (meridiem === 'am' && hours === 12) hours = 0
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

	const now = new Date(nowMs)
	const candidate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0),
	).getTime()

	if (candidate <= nowMs) return candidate + 24 * 60 * 60 * 1000
	return candidate
}

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
}

function anchorMonthDay(match: RegExpExecArray, nowMs: number): number | null {
	const monthCapture = match[1]
	if (!monthCapture) return null
	const monthKey = monthCapture.toLowerCase().slice(0, 3)
	const month = MONTHS[monthKey]
	if (month === undefined) return null
	const day = Number(match[2])
	if (day < 1 || day > 31) return null

	let hours = 0
	let minutes = 0
	if (match[3]) {
		hours = Number(match[3])
		if (match[4]) minutes = Number(match[4])
		const meridiem = match[5]?.toLowerCase()
		if (meridiem === 'pm' && hours < 12) hours += 12
		if (meridiem === 'am' && hours === 12) hours = 0
	}
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

	const now = new Date(nowMs)
	let year = now.getUTCFullYear()
	let candidate = Date.UTC(year, month, day, hours, minutes, 0, 0)
	if (candidate <= nowMs) {
		year += 1
		candidate = Date.UTC(year, month, day, hours, minutes, 0, 0)
	}
	return candidate
}

const WEEKDAYS: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
}

function anchorWeekday(match: RegExpExecArray, nowMs: number): number | null {
	const weekdayCapture = match[1]
	if (!weekdayCapture) return null
	const weekdayKey = weekdayCapture.toLowerCase().slice(0, 3)
	const target = WEEKDAYS[weekdayKey]
	if (target === undefined) return null
	const hours = Number(match[2])
	const minutes = Number(match[3])
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

	const now = new Date(nowMs)
	const currentDow = now.getUTCDay()
	let daysAhead = (target - currentDow + 7) % 7
	if (daysAhead === 0) daysAhead = 7 // never resolve to "today" — the banner means the NEXT one
	const candidate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead, hours, minutes),
	).getTime()
	return candidate
}

function clamp(candidateMs: number, nowMs: number): number | null {
	if (!Number.isFinite(candidateMs)) return null
	const min = nowMs + MIN_RETRY_MS
	const max = nowMs + MAX_RETRY_MS
	if (candidateMs < min) return null
	if (candidateMs > max) return null
	return candidateMs
}
