import { logger } from '../../../logger'

export const SLACK_API_BASE = 'https://slack.com/api'
export const REQUEST_TIMEOUT_MS = 10_000

interface SlackEnvelope {
	ok: boolean
	error?: string
	needed?: string
	warning?: string
	response_metadata?: { next_cursor?: string; messages?: string[] }
}

/**
 * A failed Slack call, carrying the machine-readable code alongside the
 * human-facing text. Tools catch this to decide whether a retry is worth
 * attempting (e.g. `not_in_channel` -> join and retry) before giving up.
 */
export class SlackApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly needed?: string,
	) {
		super(message)
		this.name = 'SlackApiError'
	}
}

/**
 * Turn a Slack error code into something an agent can act on.
 *
 * This matters more than it looks. A raw `missing_scope` or `not_in_channel`
 * reads to a model as "the platform is broken", and the documented failure mode
 * is that it stops and escalates to a human for a capability it already has, or
 * reports the tool as degraded (see the `get_actor` and pseudo-tool-call entries
 * in .claude/rules/known-pitfalls.md). Every message here names the next action.
 */
function describeSlackError(method: string, code: string, needed?: string): string {
	switch (code) {
		case 'missing_scope':
			return `Slack rejected ${method}: this workspace's Slack app was installed before the ${
				needed ? `\`${needed}\`` : 'required'
			} scope was requested. An admin needs to reconnect Slack in Settings -> Integrations to re-consent. This is a one-time workspace setup step, not a fault in this tool.`
		case 'not_in_channel':
			return `Maskin is not a member of that channel, so ${method} cannot read it. For a public channel this tool joins automatically; this one is private, so a human must invite the Maskin app with \`/invite @Maskin\` in the channel.`
		case 'channel_not_found':
			return 'No channel with that id is visible to Maskin. Channel ids look like `C0123456789` — use `slack_search_channels` to look one up by name rather than guessing.'
		case 'not_allowed_token_type':
			return `${method} needs a Slack user token, which this workspace has not granted. Reconnect Slack in Settings -> Integrations; the install will ask for search permission alongside the bot permissions.`
		case 'ratelimited':
			return `Slack rate-limited ${method}. Wait a few seconds and retry; if you are paginating, request fewer pages.`
		case 'token_revoked':
		case 'invalid_auth':
		case 'account_inactive':
			return `Slack rejected this workspace's credentials (${code}). Someone needs to reconnect Slack in Settings -> Integrations.`
		default:
			return `Slack ${method} failed: ${code}`
	}
}

/**
 * Single transport for every Slack call the MCP server makes.
 *
 * Keeps the error handling the original `chat.postMessage` implementation had
 * and which is easy to lose in a refactor: an explicit timeout, and a body
 * snippet on a non-2xx so a 429 is distinguishable from a 503 (Slack's edge can
 * answer with an HTML error page, where a bare `res.json()` throws
 * `SyntaxError: Unexpected token <` and buries the real status).
 */
export async function slackApiCall<T>(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
	httpMethod: 'GET' | 'POST' = 'POST',
): Promise<T & SlackEnvelope> {
	const url = new URL(`${SLACK_API_BASE}/${method}`)
	const init: RequestInit = {
		method: httpMethod,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	}

	if (httpMethod === 'GET') {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
		}
	} else {
		init.body = JSON.stringify(params)
	}

	let res: Response
	try {
		// Pass a string, not the URL object: it keeps the call shape identical to
		// the hand-rolled fetch this replaced, which log scrapers and test doubles
		// both match on.
		res = await fetch(url.toString(), init)
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new SlackApiError('timeout', `Slack ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`)
		}
		throw err
	}

	if (!res.ok) {
		let bodySnippet = ''
		try {
			bodySnippet = (await res.text()).slice(0, 200)
		} catch {
			// ignore — the status alone is the useful signal
		}
		throw new SlackApiError(
			`http_${res.status}`,
			`Slack ${method} HTTP ${res.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
		)
	}

	const json = (await res.json()) as T & SlackEnvelope
	if (!json.ok) {
		const code = json.error ?? 'unknown_error'
		// Always keep the raw Slack code in the message alongside the actionable
		// prose. The prose is what an agent acts on; the code is what a human
		// greps for in logs and what Slack's own docs are indexed by, so dropping
		// it would make every one of these harder to diagnose.
		const described = describeSlackError(method, code, json.needed)
		const message = described.includes(code) ? described : `${described} [${code}]`
		throw new SlackApiError(code, message, json.needed)
	}
	return json
}

/**
 * Refuse to talk to Slack with anything other than a workspace bot token.
 *
 * Slack's `chat:write.customize` scope only honours `username` + `icon_url` on
 * `chat.postMessage` when the token is the bot token; user tokens (`xoxp-`)
 * silently fall back to posting as the human owner. Since the install now holds
 * BOTH tokens, this guard is what keeps the user token on the read/search paths
 * and out of every write path.
 */
export function isSlackBotToken(token: string | undefined | null): boolean {
	return typeof token === 'string' && token.startsWith('xoxb-')
}

/** The installer's user token, granted alongside the bot token for `search:read`. */
export function isSlackUserToken(token: string | undefined | null): boolean {
	return typeof token === 'string' && token.startsWith('xoxp-')
}

/**
 * Walk a cursor-paginated Slack collection.
 *
 * Bounded on purpose: an unbounded walk on a large workspace is slow and can
 * trip rate limits. The caller is expected to report truncation to the agent —
 * a silent cap reads as "no such channel", which is the exact failure this whole
 * tool surface exists to fix (see "No silent caps" in the workflow rules).
 */
export async function slackPaginate<T>(
	token: string,
	method: string,
	params: Record<string, unknown>,
	pluck: (page: Record<string, unknown>) => T[],
	maxPages: number,
): Promise<{ items: T[]; truncated: boolean }> {
	const items: T[] = []
	let cursor: string | undefined
	for (let page = 0; page < maxPages; page++) {
		const res = await slackApiCall<Record<string, unknown>>(
			token,
			method,
			{ ...params, ...(cursor ? { cursor } : {}) },
			'GET',
		)
		items.push(...pluck(res))
		cursor = res.response_metadata?.next_cursor || undefined
		if (!cursor) return { items, truncated: false }
	}
	logger.info('Slack pagination hit the page cap', { method, maxPages, collected: items.length })
	return { items, truncated: true }
}

/**
 * Defense-in-depth: refuse to send a Slack token to anything but a Slack-owned
 * host. Node fetch already strips Authorization on cross-origin redirects, so
 * token exfil via a malicious `url_private` is bounded today — this guard
 * removes a class of regressions if that behaviour ever changes.
 *
 * Lives here rather than in fan-out.ts because both the webhook ingest path and
 * the canvas-read MCP tool download `url_private` bytes with the bot token.
 */
export function isAllowedSlackHost(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol !== 'https:') return false
	const host = parsed.hostname.toLowerCase()
	return host === 'slack.com' || host.endsWith('.slack.com')
}

/**
 * Fetch a Slack-hosted text asset (canvas body) as a string, size-capped.
 *
 * Separate from fan-out.ts's `downloadSlackFile`, which buffers arbitrary binary
 * attachments into storage. This one is for text a tool returns inline, so the
 * cap is far smaller — an agent cannot usefully consume a megabyte of canvas in
 * one tool result anyway.
 */
export async function downloadSlackText(
	url: string,
	token: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (!isAllowedSlackHost(url)) {
		throw new SlackApiError('bad_host', `Slack download rejected: host not in allow-list (${url})`)
	}
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		redirect: 'follow',
	})
	if (!res.ok) {
		if (res.status === 403) {
			throw new SlackApiError(
				'missing_scope',
				'Slack refused the download (HTTP 403) — the bot token is likely missing the `files:read` scope. An admin needs to reconnect Slack in Settings -> Integrations.',
			)
		}
		throw new SlackApiError(`http_${res.status}`, `Slack download failed: HTTP ${res.status}`)
	}
	const body = await res.text()
	if (body.length > maxBytes) {
		return { text: body.slice(0, maxBytes), truncated: true }
	}
	return { text: body, truncated: false }
}
