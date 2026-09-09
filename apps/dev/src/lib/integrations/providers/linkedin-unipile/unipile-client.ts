/**
 * Thin HTTP client for the LinkedIn v2 Messaging API. v1 paths
 * (`/api/v1/messages`, `/api/v1/chats*`) are gone — v2 puts `account_id` in
 * the URL path and renames the send-recipients field. See
 * https://developer.unipile.com/v2.0/docs/migration-messaging-api.
 *
 * Interface, not tight coupling — this is the seam the bet's architecture
 * paragraph names: swapping to Postpress or SocialAPI.ai only means writing a
 * second implementation of `LinkedInClient`. The route handler is the only
 * consumer, and it depends on the shape, not the concrete class.
 *
 * All methods return `LinkedInHttpResult` (raw status + body) rather than a
 * classified error, so the classification lives in one place — errors.ts.
 * That keeps this file dumb HTTP and every retry/taxonomy decision reviewable
 * in a single spot.
 */

export type LinkedInHttpResult<TBody = unknown> = {
	status: number
	body: TBody
	headers: Record<string, string>
}

export type LinkedInSendMessagePayload = {
	account_id: string
	recipient_urn: string
	body: string
	/** Defaults to `DEFAULT_LINKEDIN_INBOX`. */
	inbox_id?: string
}

export type LinkedInReplyPayload = {
	account_id: string
	thread_id: string
	body: string
}

export type LinkedInListConversationsQuery = {
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
 * Response envelope LinkedIn v2 sends on message-send, per the v2 reference:
 *   - start-chat (`/inboxes/:id/chats/send`)  → { object: 'ChatStarted', chat_id, message_id }
 *   - in-chat send (`/chats/:id/messages/send`) → { object: 'MessageSent', message_id }
 *
 * `message_id` is `string | string[] | null` — an array when attachments are
 * delivered as separate messages, null when nothing was sent. `id` is kept
 * only as a tolerated alias; v2 does not emit it. The route's
 * `normalizeSendResponse` reads all three forms and never turns an
 * unreadable id on a 2xx into an error — the message is already gone.
 */
export type LinkedInSendMessageResponse = {
	object?: string
	chat_id?: string
	message_id?: string | string[] | null
	/** Not emitted by v2; tolerated alias only. */
	id?: string
	sent_at?: string
}

/**
 * The MCP-facing conversation shape. This is OUR contract with agents, not
 * LinkedIn's wire shape — v2 chats arrive as { id, user_id,
 * last_message_timestamp, unread_count, last_message } and are mapped onto
 * this by `normalizeListResponse` in the route. Keeping the two separate is
 * what let the v1→v2 wire change land without agents seeing a shape change.
 */
export type LinkedInConversation = {
	thread_id: string
	participants: Array<{ recipient_urn: string; display_name: string }>
	last_message_at: string
	unread_count: number
	preview: string
}

/**
 * v2 returns the page under `data`. `conversations`/`items` remain as
 * tolerated aliases; elements are raw wire chats, not `LinkedInConversation`.
 */
export type LinkedInListConversationsResponse = {
	data?: unknown[]
	items?: unknown[]
	conversations?: unknown[]
	next_cursor?: string
	cursor?: string
}

/** `GET /v2/{account_id}/chats/{chat_id}/messages` */
export type LinkedInListMessagesQuery = {
	account_id: string
	chat_id: string
	cursor?: string
	limit?: number
}

/** `GET /v2/{account_id}/users/me/relations` — the account's connections. */
export type LinkedInListRelationsQuery = {
	account_id: string
	cursor?: string
	limit?: number
}

/**
 * `POST /v2/{account_id}/linkedin/search`
 *
 * LinkedIn takes a LinkedIn search URL rather than structured filters, so the
 * caller supplies either `keywords` (we build the URL) or an explicit `url`
 * copied from a LinkedIn search the user already refined in the browser.
 */
export type LinkedInSearchPeopleQuery = {
	account_id: string
	keywords?: string
	url?: string
	cursor?: string
	limit?: number
}

/** `GET /v2/{account_id}/users/{identifier}` */
export type LinkedInGetProfileQuery = {
	account_id: string
	/** Public identifier ("janedoe"), provider id, or `me`. */
	identifier: string
}

/**
 * `POST /v2/{account_id}/users/me/relation-requests` — send a LinkedIn
 * connection invitation to a member.
 *
 * `user_id` is the LinkedIn provider id of the target member — the same
 * opaque id that `recipient_urn` carries elsewhere on this interface (from
 * `linkedin_search_people`, `linkedin_list_connections`, etc.). Pass it
 * through verbatim.
 *
 * `message` is the optional invite note. LinkedIn enforces the length limit
 * server-side (currently 200 chars on the wire); we deliberately do NOT
 * pre-validate here so a wire-side limit change surfaces as a normal
 * `INVALID_INPUT` classification rather than a client-side rejection that
 * lies about the real constraint.
 */
export type LinkedInConnectionRequestPayload = {
	account_id: string
	user_id: string
	message?: string
}

/**
 * Response envelope LinkedIn v2 sends on a successful connection request.
 * Fields are optional because the API surface is thinner than messaging —
 * some tenants get `{ object: 'UserInvitationSent', invitation_id }`, others
 * a bare 200 with no body. The operation layer treats a 2xx as success
 * regardless.
 */
export type LinkedInConnectionRequestResponse = {
	object?: string
	invitation_id?: string
	sent_at?: string
}

/** Every paged v2 read returns its page under `data` with a `next_cursor`. */
export type LinkedInPagedResponse = {
	data?: unknown[]
	next_cursor?: string
}

// ── Content / community verbs (Task 7b) ──────────────────────────────────
//
// LinkedIn v2 uses one create-post endpoint (`POST /posts`) for both personal
// and business-page publishes; `post_as` selects the page URN when publishing
// as a page. `comment_as` is the equivalent for commenting from a page — not
// wired in v1 of this bet (the six content tools shape shipping now covers
// personal-profile commenting; page commenting is a follow-on).
//
// Every payload flows straight into a JSON body — no client-side clamping of
// `text` length, no client-side URN validation. The 3000-char LinkedIn limit
// is enforced by LinkedIn/LinkedIn and surfaces as a LINKEDIN_POST_TOO_LONG
// classification (see errors.ts). Trusting the caller here keeps the seam
// thin: the moment we start validating shape locally, changing LinkedIn's
// rules requires a client update rather than an operations-layer one.

export type LinkedInPublishPostPayload = {
	account_id: string
	text: string
	/** Present when publishing as a business page; a company URN like `urn:li:organization:12345`. */
	post_as?: string
	attachments?: unknown[]
	can_read?: string
	can_comment?: string
	quoted_post_id?: string
	specifics?: Record<string, unknown>
}

export type LinkedInCommentOnPostPayload = {
	account_id: string
	post_id: string
	text: string
}

export type LinkedInReplyToCommentPayload = {
	account_id: string
	comment_id: string
	text: string
}

export type LinkedInReadPostCommentsQuery = {
	account_id: string
	post_id: string
	cursor?: string
	limit?: number
}

export type LinkedInRetrievePostQuery = {
	account_id: string
	post_id: string
}

export type LinkedInListReactionsQuery = {
	account_id: string
	post_id: string
	cursor?: string
	limit?: number
}

export type LinkedInCountCommentsQuery = {
	account_id: string
	post_id: string
}

export interface LinkedInClient {
	sendMessage(
		payload: LinkedInSendMessagePayload,
	): Promise<LinkedInHttpResult<LinkedInSendMessageResponse | Record<string, unknown>>>
	reply(
		payload: LinkedInReplyPayload,
	): Promise<LinkedInHttpResult<LinkedInSendMessageResponse | Record<string, unknown>>>
	listConversations(
		query: LinkedInListConversationsQuery,
	): Promise<LinkedInHttpResult<LinkedInListConversationsResponse | Record<string, unknown>>>
	listMessages(
		query: LinkedInListMessagesQuery,
	): Promise<LinkedInHttpResult<LinkedInPagedResponse | Record<string, unknown>>>
	listRelations(
		query: LinkedInListRelationsQuery,
	): Promise<LinkedInHttpResult<LinkedInPagedResponse | Record<string, unknown>>>
	searchPeople(
		query: LinkedInSearchPeopleQuery,
	): Promise<LinkedInHttpResult<LinkedInPagedResponse | Record<string, unknown>>>
	getProfile(query: LinkedInGetProfileQuery): Promise<LinkedInHttpResult<Record<string, unknown>>>
	sendConnectionRequest(
		payload: LinkedInConnectionRequestPayload,
	): Promise<LinkedInHttpResult<LinkedInConnectionRequestResponse | Record<string, unknown>>>
	// Task 7b content/community verbs — see notes above the payload types.
	publishPost(
		payload: LinkedInPublishPostPayload,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	commentOnPost(
		payload: LinkedInCommentOnPostPayload,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	replyToComment(
		payload: LinkedInReplyToCommentPayload,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	readPostComments(
		query: LinkedInReadPostCommentsQuery,
	): Promise<LinkedInHttpResult<LinkedInPagedResponse | Record<string, unknown>>>
	retrievePost(
		query: LinkedInRetrievePostQuery,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
	listReactions(
		query: LinkedInListReactionsQuery,
	): Promise<LinkedInHttpResult<LinkedInPagedResponse | Record<string, unknown>>>
	countComments(
		query: LinkedInCountCommentsQuery,
	): Promise<LinkedInHttpResult<Record<string, unknown>>>
}

/**
 * Build the LinkedIn people-search URL LinkedIn's search endpoint expects.
 * Exported so a test can pin the shape — an agent passes plain keywords and
 * must never have to know LinkedIn's URL format.
 */
export function buildPeopleSearchUrl(keywords: string): string {
	return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`
}

export type LinkedInHttpClientOptions = {
	baseUrl: string
	apiKey: string
	fetchImpl?: typeof fetch
}

/**
 * Default fetch-based `LinkedInClient`. Reads LinkedIn's `X-API-KEY` auth
 * header and treats every response as JSON. `UNIPILE_BASE_URL` must NOT
 * include the `/v2` suffix — the path lives here so this client owns the
 * v1 → v2 migration surface in a single spot.
 */
export function createLinkedInHttpClient(options: LinkedInHttpClientOptions): LinkedInClient {
	const baseUrl = options.baseUrl.replace(/\/+$/, '')
	const fetchFn = options.fetchImpl ?? fetch

	async function call<T>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
	): Promise<LinkedInHttpResult<T>> {
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
			// v2: POST /v2/{account_id}/inboxes/{inbox_id}/chats/send with
			//     { users_ids, text }. `attendees_ids` → `users_ids` per the
			//     migration doc.
			//
			// NOT `/v2/{account_id}/chats/send` ("Start a Chat") — that is the
			// route for providers with no inbox concept. LinkedIn has inboxes,
			// so it answers 501 `api/not_implemented` there with "Use Start a
			// Chat in the given inbox endpoint", and every attempt to open a
			// NEW thread fails while replies into existing threads keep working.
			// Same trap as `listConversations` below; the correct route is the
			// "Start a Chat from Inbox" reference page.
			const inbox = encodeURIComponent(payload.inbox_id ?? DEFAULT_LINKEDIN_INBOX)
			return call(
				'POST',
				`/v2/${encodeURIComponent(payload.account_id)}/inboxes/${inbox}/chats/send`,
				{
					users_ids: [payload.recipient_urn],
					text: payload.body,
				},
			)
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
			// not implement it, and LinkedIn answers 501 `api/not_implemented`
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
		sendConnectionRequest(payload) {
			// POST /v2/{account_id}/users/me/relation-requests
			// Body carries `user_id` (LinkedIn provider id) and the optional
			// invite `message`. `message` is only serialised when present so a
			// null-vs-absent distinction on LinkedIn's side stays visible.
			const acc = encodeURIComponent(payload.account_id)
			const body: Record<string, unknown> = { user_id: payload.user_id }
			if (payload.message !== undefined) body.message = payload.message
			return call('POST', `/v2/${acc}/users/me/relation-requests`, body)
		},
		publishPost(payload) {
			// POST /v2/{account_id}/posts with {text, post_as?, ...}. Same endpoint
			// serves personal and business-page publish; `post_as` selects the page
			// URN when publishing as a page.
			const { account_id, ...body } = payload
			return call('POST', `/v2/${encodeURIComponent(account_id)}/posts`, body)
		},
		commentOnPost(payload) {
			// POST /v2/{account_id}/posts/{post_id}/comments with {text}.
			const acc = encodeURIComponent(payload.account_id)
			const post = encodeURIComponent(payload.post_id)
			return call('POST', `/v2/${acc}/posts/${post}/comments`, { text: payload.text })
		},
		replyToComment(payload) {
			// POST /v2/{account_id}/comments/{comment_id}/replies with {text}.
			const acc = encodeURIComponent(payload.account_id)
			const comment = encodeURIComponent(payload.comment_id)
			return call('POST', `/v2/${acc}/comments/${comment}/replies`, { text: payload.text })
		},
		readPostComments(query) {
			// GET /v2/{account_id}/posts/{post_id}/comments (offset paginated).
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			const post = encodeURIComponent(query.post_id)
			return call('GET', `/v2/${acc}/posts/${post}/comments${qs ? `?${qs}` : ''}`)
		},
		retrievePost(query) {
			// GET /v2/{account_id}/posts/{post_id}. Part of the get_post_engagement
			// fan-out: this fetches base post metadata alongside listReactions +
			// countComments.
			const acc = encodeURIComponent(query.account_id)
			const post = encodeURIComponent(query.post_id)
			return call('GET', `/v2/${acc}/posts/${post}`)
		},
		listReactions(query) {
			// GET /v2/{account_id}/posts/{post_id}/reactions (paginated). One leg
			// of the get_post_engagement fan-out — paginated because a viral post
			// can accumulate thousands of reactions and LinkedIn only returns them
			// one page at a time.
			const params = new URLSearchParams()
			if (query.cursor) params.set('cursor', query.cursor)
			if (typeof query.limit === 'number') params.set('limit', String(query.limit))
			const qs = params.toString()
			const acc = encodeURIComponent(query.account_id)
			const post = encodeURIComponent(query.post_id)
			return call('GET', `/v2/${acc}/posts/${post}/reactions${qs ? `?${qs}` : ''}`)
		},
		countComments(query) {
			// GET /v2/{account_id}/posts/{post_id}/comments?limit=1 as a stand-in
			// for a dedicated count endpoint — LinkedIn v2 exposes total via the
			// page envelope's `paging.total_count` on the same list route. The
			// operations layer reads that field rather than counting the items
			// returned. If LinkedIn ships a dedicated /comments/count route, only
			// this method needs to change.
			const acc = encodeURIComponent(query.account_id)
			const post = encodeURIComponent(query.post_id)
			return call('GET', `/v2/${acc}/posts/${post}/comments?limit=1`)
		},
	}
}
