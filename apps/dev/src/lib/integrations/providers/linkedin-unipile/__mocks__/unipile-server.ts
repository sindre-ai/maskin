import {
	type IncomingMessage,
	type ServerResponse,
	createServer as createHttpServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * In-process LinkedIn mock server for tests, rebuilt against LinkedIn Hosted
 * Auth v2 + Messaging v2. Starts on a random port so multiple test suites
 * can run in parallel; the caller passes the resolved base URL to the
 * linkedin-unipile client/route via UNIPILE_BASE_URL.
 *
 * Covers the subset of LinkedIn's v2 API this bet touches:
 *   - POST /v2/auth/link                                    — hosted-auth
 *   - POST /v2/:account_id/inboxes/:inbox_id/chats/send      — new-chat send
 *   - GET  /v2/:account_id/inboxes/:inbox_id/chats           — list chats
 *   - POST /v2/:account_id/chats/:chat_id/messages/send     — reply in thread
 *   - GET  /v2/:account_id/chats/:chat_id/messages          — read a thread
 *   - GET  /v2/:account_id/users/me/relations               — connections
 *   - POST /v2/:account_id/linkedin/search                  — people search
 *   - GET  /v2/:account_id/users/:identifier                — one profile
 *   - POST /v2/:account_id/users/me/relation-requests       — connect-request
 *
 * The v1 handlers (`/api/v1/hosted/accounts/link`, `/api/v1/messages`,
 * `/api/v1/chats*`) are gone. Signature verification is gone too — v2 uses a
 * GET redirect callback whose auth is the round-trip `state` binding, not
 * HMAC; test helpers `simulateCallbackSuccess`/`simulateCallbackError`
 * replace v1's `postSignedCallback`.
 *
 * Connect-request errors are simulated by request body — the mock inspects
 * the incoming `user_id` and returns the matching LinkedIn error envelope
 * (see `CONNECTION_REQUEST_TRIGGERS` below). This is the same pattern the
 * live LinkedIn API uses to signal `invite_quota_exceeded` and
 * `already_connected` (error envelopes on the same route), so a test that
 * drives a specific `user_id` exercises the classifier end-to-end without a
 * separate stub layer.
 */

export interface LinkedInMockServer {
	baseUrl: string
	close: () => Promise<void>
	/** Return the list of inbound requests recorded by the mock so tests can assert on what LinkedIn received. */
	inbox: () => Array<{ method: string; path: string; body: unknown }>
	/** Reset the recorded inbox between test cases. */
	resetInbox: () => void
}

// Verified against the live api.unipile.com response on 2026-09-04:
// `{"object":"HostedAuthLink","link":"https://auth.unipile.com/?token=..."}`.
// `link` is top-level — it is NOT nested under `data` (this mock and the
// client schema both had it nested, so the suite was green while every real
// connect failed schema validation and reported "temporarily unavailable").
const CANNED_AUTH_LINK = (state: string, base: string) => ({
	object: 'HostedAuthLink',
	link: `${base}/mock-wizard?state=${encodeURIComponent(state)}`,
})

// Shapes below are copied from the LinkedIn v2 reference pages, not invented.
// An invented mock is worse than no mock: it makes the suite green against a
// payload production will never send.

/**
 * LinkedIn's 501 envelope for a route it does not implement for this provider.
 * Copied from the live response shape, not invented.
 */
const CANNED_NOT_IMPLEMENTED = (useInstead: string) => ({
	status: 501,
	type: 'api/not_implemented',
	title: 'Not implemented',
	detail: `Use ${useInstead} endpoint for this provider.`,
})

/**
 * `POST /v2/:account_id/inboxes/:inbox_id/chats/send` — reference: "Start a
 * Chat from Inbox". NOT the bare `/chats/send` ("Start a Chat"), which is for
 * providers with no inbox concept and which LinkedIn answers 501 on.
 */
const CANNED_START_CHAT_RESPONSE = () => ({
	object: 'ChatStarted',
	chat_id: `mock-chat-${Date.now()}`,
	message_id: `mock-msg-${Date.now()}`,
})

/** `POST /v2/:account_id/chats/:chat_id/messages/send` — reference: "Send a Message". */
const CANNED_SEND_MESSAGE_RESPONSE = () => ({
	object: 'MessageSent',
	message_id: `mock-msg-${Date.now()}`,
})

/**
 * `GET /v2/:account_id/inboxes/:inbox_id/chats` — reference: "List inbox
 * Chats". Page nests under `data`.
 *
 * The bare `/v2/:account_id/chats` route this mock used to serve is one
 * LinkedIn does not implement — the live API answers 501 there. Serving it
 * here made the suite green against a route production can never call.
 */
const CANNED_CHATS_RESPONSE = () => ({
	object: 'ChatList',
	data: [
		{
			object: 'Chat',
			id: 'mock-chat-1',
			name: 'Ada Lovelace',
			user_id: 'mock-user-1',
			type: '1to1',
			is_1to1: true,
			is_group: false,
			is_archived: false,
			unread_count: 2,
			last_message_timestamp: '2026-09-01T10:00:00.000Z',
			last_message: { object: 'MessagePreview', text: 'Thanks for reaching out!' },
			provider: 'linkedin',
		},
	],
})

/**
 * `GET /v2/:account_id/chats/:chat_id/messages` — reference: "List Messages".
 * Field names are copied from a live api.unipile.com response (2026-09-04):
 * `text`, `timestamp`, `sender_id`, `is_sender`.
 */
const CANNED_MESSAGES_RESPONSE = () => ({
	data: [
		{
			object: 'Message',
			id: 'mock-msg-1',
			chat_id: 'mock-chat-1',
			sender_id: 'mock-user-1',
			text: 'Thanks for reaching out!',
			timestamp: '2026-09-01T10:00:00.000Z',
			is_sender: false,
		},
		{
			object: 'Message',
			id: 'mock-msg-2',
			chat_id: 'mock-chat-1',
			sender_id: 'mock-user-me',
			text: 'Happy to help — what are you working on?',
			timestamp: '2026-09-01T10:05:00.000Z',
			is_sender: true,
		},
	],
	next_cursor: 'mock-cursor-msg',
})

/**
 * `GET /v2/:account_id/users/me/relations` — reference: "List Relations".
 * The person nests under `user`; the outer object is the relation itself.
 */
const CANNED_RELATIONS_RESPONSE = () => ({
	data: [
		{
			object: 'UserRelation',
			id: 'mock-relation-1',
			created_at: '2026-08-01T00:00:00.000Z',
			user: {
				object: 'User',
				id: 'mock-user-1',
				type: 'individual',
				display_name: 'Ada Lovelace',
				first_name: 'Ada',
				last_name: 'Lovelace',
				description: 'Mathematician',
				public_identifier: 'adalovelace',
				profile_url: 'https://www.linkedin.com/in/adalovelace',
			},
		},
	],
	next_cursor: 'mock-cursor-rel',
})

/**
 * `POST /v2/:account_id/linkedin/search` — reference: "LinkedIn Search".
 * Search results are flat (no `user` wrapper) and carry `headline` +
 * `network_distance` where a relation carries `description` and neither.
 */
const CANNED_SEARCH_RESPONSE = () => ({
	data: [
		{
			object: 'PeopleSearchResult',
			id: 'mock-user-2',
			display_name: 'Grace Hopper',
			headline: 'Rear Admiral, compiler pioneer',
			network_distance: 'SECOND_DEGREE',
			location: 'New York',
			public_identifier: 'gracehopper',
			profile_url: 'https://www.linkedin.com/in/gracehopper',
		},
	],
	next_cursor: 'mock-cursor-search',
})

// ── Content / community v2 responses (Task 7b) ────────────────────────────

/** `POST /v2/:account_id/posts` — reference: "Create a Post". */
const CANNED_PUBLISH_POST_RESPONSE = () => ({
	object: 'PostPublished',
	post_id: `mock-post-${Date.now()}`,
	post_url: 'https://www.linkedin.com/feed/update/mock-post',
	published_at: '2026-09-01T10:00:00.000Z',
})

/** Simulated LinkedIn post-too-long envelope. */
const CANNED_POST_TOO_LONG_ERROR = () => ({
	object: 'Error',
	error_code: 'post_too_long',
	message: 'Post body exceeds the LinkedIn 3000-character maximum length',
})

/** `POST /v2/:account_id/posts/:post_id/comments` — reference: "Comment on Post". */
const CANNED_COMMENT_RESPONSE = () => ({
	object: 'CommentCreated',
	comment_id: `mock-comment-${Date.now()}`,
	commented_at: '2026-09-01T10:00:00.000Z',
})

/** `POST /v2/:account_id/comments/:comment_id/replies` — reference: "Reply to Comment". */
const CANNED_REPLY_TO_COMMENT_RESPONSE = () => ({
	object: 'CommentReplyCreated',
	comment_id: `mock-reply-${Date.now()}`,
	commented_at: '2026-09-01T10:05:00.000Z',
})

/** `GET /v2/:account_id/posts/:post_id/comments`. */
const CANNED_POST_COMMENTS_RESPONSE = () => ({
	object: 'CommentList',
	data: [
		{
			object: 'Comment',
			id: 'mock-comment-1',
			text: 'Great post!',
			created_at: '2026-09-01T10:01:00.000Z',
			author: { id: 'mock-user-1', display_name: 'Ada Lovelace' },
		},
	],
	paging: { total_count: 1 },
})

/** `GET /v2/:account_id/posts/:post_id`. */
const CANNED_RETRIEVE_POST_RESPONSE = () => ({
	object: 'Post',
	id: 'mock-post-1',
	author_urn: 'urn:li:person:mock-user-me',
	author: { id: 'urn:li:person:mock-user-me', display_name: 'Sebk' },
	published_at: '2026-09-01T09:00:00.000Z',
	text: 'Mock post body used by the linkedin-unipile test suite.',
})

/** `GET /v2/:account_id/posts/:post_id/reactions`. */
const CANNED_REACTIONS_RESPONSE = () => ({
	object: 'ReactionList',
	data: [
		{
			object: 'Reaction',
			user_id: 'mock-user-1',
			reaction_type: 'LIKE',
			user: { id: 'mock-user-1', display_name: 'Ada Lovelace' },
		},
		{
			object: 'Reaction',
			user_id: 'mock-user-2',
			reaction_type: 'CELEBRATE',
			user: { id: 'mock-user-2', display_name: 'Grace Hopper' },
		},
	],
})

/** `GET /v2/:account_id/users/:identifier` — reference: "Get Profile". */
const CANNED_PROFILE_RESPONSE = () => ({
	object: 'UserProfile',
	id: 'mock-user-2',
	type: 'individual',
	display_name: 'Grace Hopper',
	first_name: 'Grace',
	last_name: 'Hopper',
	description: 'Rear Admiral, compiler pioneer',
	public_identifier: 'gracehopper',
	profile_url: 'https://www.linkedin.com/in/gracehopper',
	location: 'New York',
})

/**
 * `GET /v2/:account_id/users/me` — the connected account's own profile. R11-A
 * reads `public_identifier` off this response and persists it on
 * `integrations.unipile_acc_slug` as the account half of the instance slug
 * (`linkedin-{unipileAccSlug}-{identitySlug}`, spec §1.3). `provider_id` is
 * the person URN suffix (`urn:li:person:<suffix>`) used as `identityUrn` on
 * the personal MCP instance.
 */
const CANNED_ME_PROFILE_RESPONSE = () => ({
	object: 'UserProfile',
	id: 'mock-user-me',
	provider_id: 'mock-user-me',
	type: 'individual',
	display_name: 'Sebastian Bille',
	first_name: 'Sebastian',
	last_name: 'Bille',
	public_identifier: 'sebastianbille',
	profile_url: 'https://www.linkedin.com/in/sebastianbille',
})

/**
 * `GET /v2/:account_id/linkedin/company/pages` — pages the connected
 * LinkedIn member admins. R11-A's enumeration path calls this once per
 * credential and registers one MCP instance per entry. The fixture returns
 * two admined pages: one messaging-enabled (Maskin) and one publish-only
 * (Sample) — the two branches spec §2's messaging-suite filter has to cover.
 * A test override (`planManagedPagesResponse`) can swap the payload for
 * cases that need a specific fixture (e.g. zero admined pages).
 */
const CANNED_MANAGED_PAGES_RESPONSE = () => ({
	object: 'ManagedCompanyPageList',
	data: [
		{
			object: 'ManagedCompanyPage' as const,
			object_urn: 'urn:li:organization:11111',
			public_identifier: 'maskinio',
			name: 'Maskin',
			mailbox_id: 'mock-mailbox-maskinio',
			messaging_enabled: true,
		},
		{
			object: 'ManagedCompanyPage' as const,
			object_urn: 'urn:li:organization:22222',
			public_identifier: 'sample-page',
			name: 'Sample Page',
			mailbox_id: null,
			messaging_enabled: false,
		},
	],
})

let managedPagesOverride: null | ReturnType<typeof CANNED_MANAGED_PAGES_RESPONSE> = null
export function planManagedPagesResponse(
	body: ReturnType<typeof CANNED_MANAGED_PAGES_RESPONSE>,
): void {
	managedPagesOverride = body
}
export function clearManagedPagesOverride(): void {
	managedPagesOverride = null
}

/**
 * `POST /v2/:account_id/users/me/relation-requests` — LinkedIn connect
 * request. The live LinkedIn API answers with a thin `{ object,
 * invitation_id }` envelope on success (some tenants return a bare 200);
 * this mock returns the fuller shape so a test that reads `invitation_id`
 * exercises the normalizer's happy path.
 */
const CANNED_CONNECTION_REQUEST_RESPONSE = () => ({
	object: 'UserInvitationSent',
	invitation_id: `mock-invite-${Date.now()}`,
})

/**
 * Trigger `user_id` values a test can send to force an error envelope on the
 * connect-request route. The values match the wire discriminators in
 * `LINKEDIN_CONNECTION_REQUEST_MARKERS` so the classifier exercises its real
 * detection branches, not a mock-only side path.
 */
export const CONNECTION_REQUEST_TRIGGERS = {
	/** Force the invite-quota-exceeded envelope (400 with error_code marker). */
	inviteQuotaExceeded: 'mock-trigger-invite-quota-exceeded',
	/** Force the already-connected envelope (409 with error_code marker). */
	alreadyConnected: 'mock-trigger-already-connected',
} as const

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/**
 * Overrides for test cases that need a non-happy-path response — LINKEDIN_POST_TOO_LONG
 * on the two publish routes, network flakes, etc. `setResponseOverride`
 * plants a single-shot override matched by (method, path-regex) that returns
 * the given status + body once, then removes itself.
 */
type ResponseOverride = {
	match: (method: string, path: string) => boolean
	status: number
	body: unknown
}

const responseOverrides: ResponseOverride[] = []

export function planPostTooLongResponse(): void {
	responseOverrides.push({
		match: (method, path) => method === 'POST' && /^\/v2\/[^/]+\/posts$/.test(path),
		status: 400,
		body: CANNED_POST_TOO_LONG_ERROR(),
	})
}

export function planResponseOverride(override: ResponseOverride): void {
	responseOverrides.push(override)
}

export function clearResponseOverrides(): void {
	responseOverrides.length = 0
}

export async function startLinkedInMock(): Promise<LinkedInMockServer> {
	const recorded: Array<{ method: string; path: string; body: unknown }> = []
	const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
		const method = (req.method ?? 'GET').toUpperCase()
		const url = req.url ?? '/'
		const rawBody = await readBody(req)
		let parsed: unknown = null
		if (rawBody) {
			try {
				parsed = JSON.parse(rawBody)
			} catch {
				parsed = rawBody
			}
		}
		recorded.push({ method, path: url, body: parsed })

		const send = (status: number, body: unknown): void => {
			res.statusCode = status
			res.setHeader('Content-Type', 'application/json')
			res.end(JSON.stringify(body))
		}

		// Single-shot response overrides fire before any canned route so a test
		// can inject a specific error envelope on a matching path.
		const overrideIndex = responseOverrides.findIndex((o) => o.match(method, url))
		if (overrideIndex !== -1) {
			const override = responseOverrides[overrideIndex] as ResponseOverride
			responseOverrides.splice(overrideIndex, 1)
			return send(override.status, override.body)
		}

		if (method === 'POST' && url === '/v2/auth/link') {
			const state =
				typeof parsed === 'object' && parsed !== null && 'state' in parsed
					? String((parsed as { state?: unknown }).state ?? '')
					: ''
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
			return send(200, CANNED_AUTH_LINK(state, base))
		}
		// v2 messaging endpoints — account_id is a path segment.
		if (method === 'POST' && /^\/v2\/[^/]+\/inboxes\/[^/]+\/chats\/send$/.test(url)) {
			return send(200, CANNED_START_CHAT_RESPONSE())
		}
		// The bare "Start a Chat" route, served the way the live API serves it:
		// 501 for a provider that uses inboxes. Answering 200 here is what let
		// the suite stay green while every new-thread send failed in production.
		if (method === 'POST' && /^\/v2\/[^/]+\/chats\/send$/.test(url)) {
			return send(501, CANNED_NOT_IMPLEMENTED('Start a Chat in the given inbox'))
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/inboxes\/[^/]+\/chats(\?.*)?$/.test(url)) {
			return send(200, CANNED_CHATS_RESPONSE())
		}
		if (method === 'POST' && /^\/v2\/[^/]+\/chats\/[^/]+\/messages\/send$/.test(url)) {
			return send(200, CANNED_SEND_MESSAGE_RESPONSE())
		}
		// Read surfaces. The messages route must be tested BEFORE the send route
		// above would ever be reached by a GET, and the relations route before
		// the generic `/users/:identifier` one — `/users/me/relations` also
		// matches `/users/:identifier` with identifier="me", which is exactly
		// the collision that makes `/users/relations` answer 200 with one
		// unrelated profile on the live API.
		if (method === 'GET' && /^\/v2\/[^/]+\/chats\/[^/]+\/messages(\?.*)?$/.test(url)) {
			return send(200, CANNED_MESSAGES_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/users\/me\/relations(\?.*)?$/.test(url)) {
			return send(200, CANNED_RELATIONS_RESPONSE())
		}
		// Connect-request route must be checked BEFORE the generic
		// `/users/:identifier` route below — the URL `/users/me/relation-requests`
		// also matches `/users/:identifier` with identifier="me" as a prefix,
		// same collision family that gave us the `/users/relations` bug.
		if (method === 'POST' && /^\/v2\/[^/]+\/users\/me\/relation-requests$/.test(url)) {
			const userId =
				typeof parsed === 'object' && parsed !== null && 'user_id' in parsed
					? String((parsed as { user_id?: unknown }).user_id ?? '')
					: ''
			if (userId === CONNECTION_REQUEST_TRIGGERS.inviteQuotaExceeded) {
				// Shape mirrors LinkedIn's own error envelope: `error_code` is
				// the discriminator the classifier reads.
				return send(400, {
					error_code: 'invite_quota_exceeded',
					message: "LinkedIn's weekly invitation limit for this account is reached.",
				})
			}
			if (userId === CONNECTION_REQUEST_TRIGGERS.alreadyConnected) {
				return send(409, {
					error_code: 'already_connected',
					message: 'Target member is already a connection or has a pending invitation.',
				})
			}
			return send(200, CANNED_CONNECTION_REQUEST_RESPONSE())
		}
		if (method === 'POST' && /^\/v2\/[^/]+\/linkedin\/search(\?.*)?$/.test(url)) {
			return send(200, CANNED_SEARCH_RESPONSE())
		}
		// R11-A enumeration route: pages the connected member admins. Must
		// be tested BEFORE the generic /users/:identifier catch-all below, and
		// BEFORE the generic /posts routes (the path doesn't overlap those but
		// grouping the linkedin/ namespace here keeps the R11 additions together).
		if (
			method === 'GET' &&
			/^\/v2\/[^/]+\/linkedin\/company\/pages(\?.*)?$/.test(url)
		) {
			return send(200, managedPagesOverride ?? CANNED_MANAGED_PAGES_RESPONSE())
		}
		// ── Content / community routes (Task 7b) ──────────────────────────
		// Order matters: nested paths must be tested before the /users/:identifier
		// catch-all, otherwise "posts" would be resolved as a user handle.
		if (method === 'POST' && /^\/v2\/[^/]+\/posts$/.test(url)) {
			return send(200, CANNED_PUBLISH_POST_RESPONSE())
		}
		if (method === 'POST' && /^\/v2\/[^/]+\/posts\/[^/]+\/comments$/.test(url)) {
			return send(200, CANNED_COMMENT_RESPONSE())
		}
		if (method === 'POST' && /^\/v2\/[^/]+\/comments\/[^/]+\/replies$/.test(url)) {
			return send(200, CANNED_REPLY_TO_COMMENT_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/posts\/[^/]+\/comments(\?.*)?$/.test(url)) {
			return send(200, CANNED_POST_COMMENTS_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/posts\/[^/]+\/reactions(\?.*)?$/.test(url)) {
			return send(200, CANNED_REACTIONS_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/posts\/[^/]+(\?.*)?$/.test(url)) {
			return send(200, CANNED_RETRIEVE_POST_RESPONSE())
		}
		// `/users/me` returns the connected account's own profile — spec §1.4
		// step 1 reads `public_identifier` off it as the account slug. Must
		// resolve BEFORE the catch-all `/users/:identifier` route below so it
		// isn't misread as a lookup of a user literally named "me".
		if (method === 'GET' && /^\/v2\/[^/]+\/users\/me(\?.*)?$/.test(url)) {
			return send(200, CANNED_ME_PROFILE_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/users\/[^/]+(\?.*)?$/.test(url)) {
			return send(200, CANNED_PROFILE_RESPONSE())
		}
		if (method === 'GET' && url.startsWith('/mock-wizard')) {
			res.statusCode = 200
			res.setHeader('Content-Type', 'text/html')
			return res.end('<html><body>mock linkedin wizard</body></html>')
		}
		return send(404, { error: 'not_found', path: url })
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as AddressInfo).port
	const baseUrl = `http://127.0.0.1:${port}`

	return {
		baseUrl,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
		inbox: () => recorded.slice(),
		resetInbox: () => {
			recorded.length = 0
		},
	}
}

/**
 * Test helper: GET the Maskin callback URL with the success query params
 * LinkedIn v2 sends after a hosted-wizard completion. `redirect: 'manual'` so
 * the test sees the 302 rather than following it.
 */
export async function simulateCallbackSuccess(
	callbackUrl: string,
	args: { state: string; account_id: string; provider?: string },
): Promise<Response> {
	const url = new URL(callbackUrl)
	url.searchParams.set('state', args.state)
	url.searchParams.set('account_id', args.account_id)
	url.searchParams.set('provider', args.provider ?? 'linkedin')
	return fetch(url.toString(), { method: 'GET', redirect: 'manual' })
}

/**
 * Test helper: GET the Maskin callback URL with the error query params
 * LinkedIn v2 sends on a hosted-wizard failure.
 */
export async function simulateCallbackError(
	callbackUrl: string,
	args: {
		state?: string
		error_type: string
		error_title?: string
		error_detail?: string
	},
): Promise<Response> {
	const url = new URL(callbackUrl)
	if (args.state) url.searchParams.set('state', args.state)
	url.searchParams.set('error_type', args.error_type)
	if (args.error_title) url.searchParams.set('error_title', args.error_title)
	if (args.error_detail) url.searchParams.set('error_detail', args.error_detail)
	return fetch(url.toString(), { method: 'GET', redirect: 'manual' })
}
