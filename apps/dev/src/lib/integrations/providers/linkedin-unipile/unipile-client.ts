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
	/** Defaults to `DEFAULT_LINKEDIN_INBOX`. */
	inbox_id?: string
}

/**
 * LinkedIn's primary inbox. `GET /v2/{account_id}/inboxes` lists the rest
 * (CLASSIC_ARCHIVED, …); the primary one is what "my conversations" means and
 * is the only inbox this surface reads today.
 */
export const DEFAULT_LINKEDIN_INBOX = 'CLASSIC_PRIMARY'

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

/** `GET /v2/{account_id}/chats/{chat_id}/messages` */
export type UnipileListMessagesQuery = {
	account_id: string
	chat_id: string
	cursor?: string
	limit?: number
}

/** `GET /v2/{account_id}/users/me/relations` — the account's connections. */
export type UnipileListRelationsQuery = {
	account_id: string
	cursor?: string
	limit?: number
}

/**
 * `POST /v2/{account_id}/linkedin/search`
 *
 * Unipile takes a LinkedIn search URL rather than structured filters, so the
 * caller supplies either `keywords` (we build the URL) or an explicit `url`
 * copied from a LinkedIn search the user already refined in the browser.
 */
export type UnipileSearchPeopleQuery = {
	account_id: string
	keywords?: string
	url?: string
	cursor?: string
	limit?: number
}

/** `GET /v2/{account_id}/users/{identifier}` */
export type UnipileGetProfileQuery = {
	account_id: string
	/** Public identifier ("janedoe"), provider id, or `me`. */
	identifier: string
}

/** Every paged v2 read returns its page under `data` with a `next_cursor`. */
export type UnipilePagedResponse = {
	data?: unknown[]
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
	listMessages(
		query: UnipileListMessagesQuery,
	): Promise<UnipileHttpResult<UnipilePagedResponse | Record<string, unknown>>>
	listRelations(
		query: UnipileListRelationsQuery,
	): Promise<UnipileHttpResult<UnipilePagedResponse | Record<string, unknown>>>
	searchPeople(
		query: UnipileSearchPeopleQuery,
	): Promise<UnipileHttpResult<UnipilePagedResponse | Record<string, unknown>>>
	getProfile(query: UnipileGetProfileQuery): Promise<UnipileHttpResult<Record<string, unknown>>>
}

/**
 * Build the LinkedIn people-search URL Unipile's search endpoint expects.
 * Exported so a test can pin the shape — an agent passes plain keywords and
 * must never have to know LinkedIn's URL format.
 */
export function buildPeopleSearchUrl(keywords: string): string {
	return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`
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
			// v2: GET /v2/{account_id}/inboxes/{inbox_id}/chats?cursor=…&limit=…
			//
			// NOT `/v2/{account_id}/chats` — that route exists but LinkedIn does
			// not implement it, and Unipile answers 501 `api/not_implemented`
			// with "Use List inbox Chats endpoint for this provider." Verified
			// against api.unipile.com on 2026-09-04: the inbox route returns real
			// conversations for the same account the bare route rejects.
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const inbox = encodeURIComponent(query.inbox_id ?? DEFAULT_LINKEDIN_INBOX)
			return call(
				'GET',
				`/v2/${encodeURIComponent(query.account_id)}/inboxes/${inbox}/chats${qs ? `?${qs}` : ''}`,
			)
		},
		listMessages(query) {
			// GET /v2/{account_id}/chats/{chat_id}/messages
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			const chat = encodeURIComponent(query.chat_id)
			return call('GET', `/v2/${acc}/chats/${chat}/messages${qs ? `?${qs}` : ''}`)
		},
		listRelations(query) {
			// GET /v2/{account_id}/users/me/relations
			//
			// NOT `/users/relations`: that path matches the `/users/{identifier}`
			// route and resolves "relations" as a profile name, answering 200
			// with a single unrelated person. A wrong-but-successful response is
			// worse than a 404 — it looks like it works.
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			return call('GET', `/v2/${acc}/users/me/relations${qs ? `?${qs}` : ''}`)
		},
		searchPeople(query) {
			// POST /v2/{account_id}/linkedin/search with a LinkedIn search URL.
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			const url = query.url ?? buildPeopleSearchUrl(query.keywords ?? '')
			return call('POST', `/v2/${acc}/linkedin/search${qs ? `?${qs}` : ''}`, { url })
		},
		getProfile(query) {
			// GET /v2/{account_id}/users/{identifier}; `me` returns the account's
			// own profile.
			const acc = encodeURIComponent(query.account_id)
			return call('GET', `/v2/${acc}/users/${encodeURIComponent(query.identifier)}`)
		},
	}
}
