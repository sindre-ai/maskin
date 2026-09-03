/**
 * Thin HTTP client for the Unipile v2 Messaging API. v1 paths
 * (`/api/v1/messages`, `/api/v1/chats*`) are gone — v2 puts `account_id` in
 * the URL path and renames the send-recipients field. See
 * https://developer.unipile.com/v2.0/docs/migration-messaging-api.
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

/**
 * Response envelope Unipile v2 sends on message-send. The migration doc
 * confirms `account_id` in the path but does not fully spec the response
 * envelope; the route's normalizer accepts both `id` and `message_id` and
 * defaults `sent_at` to now if absent. Kept permissive here so a shape drift
 * on Unipile's side surfaces in the classifier layer, not as a TypeScript
 * error.
 */
export type UnipileSendMessageResponse = {
	id?: string
	message_id?: string
	sent_at?: string
}

export type UnipileConversation = {
	thread_id: string
	participants: Array<{ recipient_urn: string; display_name: string }>
	last_message_at: string
	unread_count: number
	preview: string
}

export type UnipileListConversationsResponse = {
	conversations?: UnipileConversation[]
	items?: UnipileConversation[]
	data?: UnipileConversation[]
	next_cursor?: string
	cursor?: string
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
 * header and treats every response as JSON. `UNIPILE_BASE_URL` must NOT
 * include the `/v2` suffix — the path lives here so this client owns the
 * v1 → v2 migration surface in a single spot.
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
			// v1: POST /api/v1/messages with { account_id, recipient, text }
			// v2: POST /v2/{account_id}/chats/send with { users_ids, text }
			// `attendees_ids` → `users_ids` per the migration doc.
			return call('POST', `/v2/${encodeURIComponent(payload.account_id)}/chats/send`, {
				users_ids: [payload.recipient_urn],
				text: payload.body,
			})
		},
		reply(payload) {
			// v1: POST /api/v1/chats/{id}/messages with { account_id, text }
			// v2: POST /v2/{account_id}/chats/{chat_id}/messages/send with { text }
			return call(
				'POST',
				`/v2/${encodeURIComponent(payload.account_id)}/chats/${encodeURIComponent(payload.thread_id)}/messages/send`,
				{ text: payload.body },
			)
		},
		listConversations(query) {
			// v1: GET /api/v1/chats?account_id=…
			// v2: GET /v2/{account_id}/chats?cursor=…&limit=…
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			return call('GET', `/v2/${encodeURIComponent(query.account_id)}/chats${qs ? `?${qs}` : ''}`)
		},
	}
}
