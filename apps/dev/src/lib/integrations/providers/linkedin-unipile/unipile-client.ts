/**
 * Thin HTTP client for the Unipile Hosted Messaging API — narrow surface, only
 * the three verbs the LinkedIn MCP tools need. Task 2 (Unipile Hosted Wizard
 * connect flow) is expected to fold this into a broader provider client that
 * also handles the OAuth wizard callback; when it does, the routes in
 * apps/dev/src/routes/integrations-linkedin-unipile.ts should keep calling
 * the same interface (`UnipileClient`) so no route logic has to move.
 *
 * Interface, not tight coupling — this is the seam the bet's architecture
 * paragraph names: swapping to Postpress or SocialAPI.ai only means writing a
 * second implementation of `UnipileClient`. The route handler is the only
 * consumer, and it depends on the shape, not the concrete class.
 *
 * All methods return `UnipileHttpResult` (raw status + body) rather than a
 * classified error, so the classification lives in one place — errors.ts.
 * That keeps this file dumb HTTP and every retry/taxonomy decision reviewable
 * in a single spot.
 */

export type UnipileHttpResult<TBody = unknown> = {
	status: number
	body: TBody
	headers: Record<string, string>
}

export type UnipileSendMessagePayload = {
	account_id: string
	recipient_urn: string
	body: string
}

export type UnipileReplyPayload = {
	account_id: string
	thread_id: string
	body: string
}

export type UnipileListConversationsQuery = {
	account_id: string
	cursor?: string
	limit?: number
}

export type UnipileSendMessageResponse = {
	id: string
	sent_at: string
}

export type UnipileConversation = {
	thread_id: string
	participants: Array<{ recipient_urn: string; display_name: string }>
	last_message_at: string
	unread_count: number
	preview: string
}

export type UnipileListConversationsResponse = {
	conversations: UnipileConversation[]
	next_cursor?: string
}

export interface UnipileClient {
	sendMessage(
		payload: UnipileSendMessagePayload,
	): Promise<UnipileHttpResult<UnipileSendMessageResponse | Record<string, unknown>>>
	reply(
		payload: UnipileReplyPayload,
	): Promise<UnipileHttpResult<UnipileSendMessageResponse | Record<string, unknown>>>
	listConversations(
		query: UnipileListConversationsQuery,
	): Promise<UnipileHttpResult<UnipileListConversationsResponse | Record<string, unknown>>>
}

export type UnipileHttpClientOptions = {
	baseUrl: string
	apiKey: string
	fetchImpl?: typeof fetch
}

/**
 * Default fetch-based `UnipileClient`. Reads Unipile's `X-API-KEY` auth
 * header and treats every response as JSON — Unipile returns JSON on both
 * success and error paths per their catalog, so a JSON.parse failure is
 * itself a signal of an upstream misbehaviour and surfaces as a 502-ish
 * `UNIPILE_UNAVAILABLE` at the classifier layer.
 *
 * Task 2 replaces this with a shared client once the Hosted Wizard callback
 * exists — both point at the same base URL and use the same header shape, so
 * the surface stays stable.
 */
export function createUnipileHttpClient(options: UnipileHttpClientOptions): UnipileClient {
	const baseUrl = options.baseUrl.replace(/\/+$/, '')
	const fetchFn = options.fetchImpl ?? fetch

	async function call<T>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
	): Promise<UnipileHttpResult<T>> {
		const url = `${baseUrl}${path}`
		const init: RequestInit = {
			method,
			headers: {
				'X-API-KEY': options.apiKey,
				Accept: 'application/json',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}
		const response = await fetchFn(url, init)
		const headers: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			headers[key] = value
		})
		const text = await response.text()
		let parsed: unknown = {}
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text)
			} catch {
				parsed = { raw: text }
			}
		}
		return { status: response.status, body: parsed as T, headers }
	}

	return {
		sendMessage(payload) {
			return call('POST', '/api/v1/messages', {
				account_id: payload.account_id,
				recipient: payload.recipient_urn,
				text: payload.body,
			})
		},
		reply(payload) {
			return call('POST', `/api/v1/chats/${encodeURIComponent(payload.thread_id)}/messages`, {
				account_id: payload.account_id,
				text: payload.body,
			})
		},
		listConversations(query) {
			const params = new URLSearchParams()
			params.set('account_id', query.account_id)
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			return call('GET', `/api/v1/chats?${params.toString()}`)
		},
	}
}
