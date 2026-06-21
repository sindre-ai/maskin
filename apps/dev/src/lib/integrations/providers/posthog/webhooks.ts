import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stable enum used as `metadata.source` on insights. T3's immediate-triage
 * trigger matches against this literal — renaming is a contract change.
 */
export type PosthogSource = 'posthog_exception'

export interface PosthogExceptionEvent {
	uuid?: string
	event: '$exception'
	distinct_id?: string
	timestamp?: string
	properties?: Record<string, unknown> & {
		$exception_fingerprint?: string
		$exception_issue_id?: string
		$exception_type?: string
		$exception_message?: string
		$exception_list?: Array<{
			type?: string
			value?: string
			stacktrace?: { frames?: Array<Record<string, unknown>> } | string
		}>
		$exception_stack_trace_raw?: string
		$session_id?: string
		$current_url?: string
		$browser?: string
		$os?: string
		email?: string
	}
}

/**
 * PostHog Actions deliver the event nested under `event`. Some setups also
 * include a top-level `team_id` and `site_url`. We only read the inner event.
 */
export interface PosthogWebhookPayload {
	event: PosthogExceptionEvent | string
	team_id?: number | string
	site_url?: string
}

const MERGE_BLAME_WINDOW_HOURS = 24
const MAX_STACK_BYTES = 4000
const MAX_STACK_RENDER_BYTES = 1500

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`

/**
 * Verify HMAC-SHA256 of the raw body against the configured shared secret.
 * Matches the Coolify shape so the PostHog Action just needs a custom header
 * with `sha256=<hex>` of the JSON body. Constant-time comparison.
 */
export function verifyPosthogSignature(body: string, signature: string, secret: string): boolean {
	if (!signature) return false
	const stripped = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature
	const computed = createHmac('sha256', secret).update(body).digest('hex')
	const expected = Buffer.from(computed)
	const actual = Buffer.from(stripped)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

/**
 * PostHog can deliver either the bare event or a wrapper with `event` nested.
 * Returns the inner event when it's an exception, or null when it isn't.
 */
export function extractExceptionEvent(
	payload: PosthogWebhookPayload,
): PosthogExceptionEvent | null {
	const inner = payload.event
	if (
		inner &&
		typeof inner === 'object' &&
		(inner as PosthogExceptionEvent).event === '$exception'
	) {
		return inner as PosthogExceptionEvent
	}
	return null
}

/**
 * PostHog's own fingerprint is the right key — it's what their issue grouping
 * uses, so dedupe-on-this matches what an engineer would see in PostHog.
 * Fall back to issue_id, then type+message, so a stripped-down payload still
 * dedupes instead of spamming new insights.
 */
export function fingerprintFor(event: PosthogExceptionEvent): string {
	const props = event.properties ?? {}
	if (props.$exception_fingerprint) return `posthog_exception:${props.$exception_fingerprint}`
	if (props.$exception_issue_id) return `posthog_exception:issue:${props.$exception_issue_id}`
	const type = props.$exception_type ?? 'UnknownError'
	const message = (props.$exception_message ?? '').slice(0, 200)
	return `posthog_exception:${type}:${message}`
}

const renderStackTrace = (event: PosthogExceptionEvent): string => {
	const props = event.properties ?? {}
	if (props.$exception_stack_trace_raw && typeof props.$exception_stack_trace_raw === 'string') {
		return truncate(props.$exception_stack_trace_raw, MAX_STACK_BYTES)
	}
	const first = props.$exception_list?.[0]
	if (!first) return ''
	if (typeof first.stacktrace === 'string') return truncate(first.stacktrace, MAX_STACK_BYTES)
	const frames = first.stacktrace?.frames ?? []
	if (frames.length === 0) return ''
	const rendered = frames
		.slice(0, 20)
		.map((f) => {
			const fn = (f as { function?: string }).function ?? '(anonymous)'
			const file = (f as { filename?: string }).filename ?? '(unknown)'
			const line = (f as { lineno?: number }).lineno
			const col = (f as { colno?: number }).colno
			const loc = line ? `:${line}${col ? `:${col}` : ''}` : ''
			return `  at ${fn} (${file}${loc})`
		})
		.join('\n')
	return truncate(rendered, MAX_STACK_BYTES)
}

export interface MergeBlameWindow {
	since: string
	until: string
	pulls_url: string
}

/**
 * The "merge-blame window" is the last 24h of merged PRs on the maskin repo.
 * Computing it here keeps the AC-T4 5-min budget intact — pulling the actual PR
 * list from GitHub on the webhook hot path would add a network call to every
 * exception (and a token dependency). We capture the timestamps and a search
 * URL the engineer clicks through to read the merged-PR list.
 */
export function mergeBlameWindow(now: Date = new Date()): MergeBlameWindow {
	const since = new Date(now.getTime() - MERGE_BLAME_WINDOW_HOURS * 60 * 60 * 1000)
	const sinceIso = since.toISOString()
	const untilIso = now.toISOString()
	const sinceDate = sinceIso.slice(0, 10)
	const untilDate = untilIso.slice(0, 10)
	// GitHub's PR search accepts `merged:YYYY-MM-DD..YYYY-MM-DD` range queries.
	// We use the date form (not timestamp) because GitHub search rejects sub-day
	// precision for some scopes; the human still gets the right window of PRs.
	const pulls_url = `https://github.com/sindre-ai/maskin/pulls?q=is%3Apr+is%3Amerged+merged%3A${sinceDate}..${untilDate}`
	return { since: sinceIso, until: untilIso, pulls_url }
}

export interface BuiltInsight {
	source: PosthogSource
	fingerprint: string
	title: string
	content: string
	context: Record<string, unknown>
}

export function buildInsightForEvent(
	event: PosthogExceptionEvent,
	options: { siteUrl?: string; now?: Date } = {},
): BuiltInsight {
	const props = event.properties ?? {}
	const fingerprint = fingerprintFor(event)
	const exceptionType = props.$exception_type ?? 'Exception'
	const exceptionMessage = props.$exception_message ?? '(no message)'
	const stack = renderStackTrace(event)
	const blame = mergeBlameWindow(options.now)

	const userLabel = (props.email as string | undefined) ?? event.distinct_id ?? '(anonymous user)'
	const sessionId = (props.$session_id as string | undefined) ?? null
	const currentUrl = (props.$current_url as string | undefined) ?? null
	const browser = (props.$browser as string | undefined) ?? null
	const os = (props.$os as string | undefined) ?? null

	const context: Record<string, unknown> = {
		exception_type: exceptionType,
		exception_message: exceptionMessage,
		distinct_id: event.distinct_id,
		user_email: props.email,
		session_id: sessionId,
		current_url: currentUrl,
		browser,
		os,
		event_uuid: event.uuid,
		event_timestamp: event.timestamp,
		stack_trace: stack ? truncate(stack, MAX_STACK_BYTES) : null,
		merge_blame_window: blame,
		site_url: options.siteUrl,
	}

	const title = `PostHog exception — ${exceptionType}: ${truncate(exceptionMessage, 80)}`
	const content = [
		`**${exceptionType}** — ${truncate(exceptionMessage, 200)}`,
		'',
		`- user: ${userLabel}`,
		sessionId ? `- session: \`${sessionId}\`` : null,
		currentUrl ? `- url: ${currentUrl}` : null,
		browser || os ? `- env: ${[browser, os].filter(Boolean).join(' / ')}` : null,
		event.timestamp ? `- captured at: ${event.timestamp}` : null,
		'',
		stack ? '**Stack trace**' : null,
		stack ? '```' : null,
		stack ? truncate(stack, MAX_STACK_RENDER_BYTES) : null,
		stack ? '```' : null,
		stack ? '' : null,
		'**Merge-blame window (last 24h of merged PRs)**',
		`- ${blame.since} → ${blame.until}`,
		`- [Open merged PRs on GitHub](${blame.pulls_url})`,
	]
		.filter((line): line is string => line !== null)
		.join('\n')

	return {
		source: 'posthog_exception',
		fingerprint,
		title,
		content,
		context,
	}
}
