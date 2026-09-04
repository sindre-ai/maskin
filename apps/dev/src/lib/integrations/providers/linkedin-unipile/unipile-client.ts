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
 * Response envelope Unipile v2 sends on message-send, per the v2 reference:
 *   - start-chat (`/chats/send`)              → { object: 'ChatStarted', chat_id, message_id }
 *   - in-chat send (`/chats/:id/messages/send`) → { object: 'MessageSent', message_id }
 *
 * `message_id` is `string | string[] | null` — an array when attachments are
 * delivered as separate messages, null when nothing was sent. `id` is kept
 * only as a tolerated alias; v2 does not emit it. The route's
 * `normalizeSendResponse` reads all three forms and never turns an
 * unreadable id on a 2xx into an error — the message is already gone.
 */
export type UnipileSendMessageResponse = {
	object?: string
	chat_id?: string
	message_id?: string | string[] | null
	/** Not emitted by v2; tolerated alias only. */
	id?: string
	sent_at?: string
}

/**
 * The MCP-facing conversation shape. This is OUR contract with agents, not
 * Unipile's wire shape — v2 chats arrive as { id, user_id,
 * last_message_timestamp, unread_count, last_message } and are mapped onto
 * this by `normalizeListResponse` in the route. Keeping the two separate is
 * what let the v1→v2 wire change land without agents seeing a shape change.
 */
export type UnipileConversation = {
	thread_id: string
	participants: Array<{ recipient_urn: string; display_name: string }>
	last_message_at: string
	unread_count: number
	preview: string
}

/**
 * v2 returns the page under `data`. `conversations`/`items` remain as
 * tolerated aliases; elements are raw wire chats, not `UnipileConversation`.
 */
export type UnipileListConversationsResponse = {
	data?: unknown[]
	items?: unknown[]
	conversations?: unknown[]
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
