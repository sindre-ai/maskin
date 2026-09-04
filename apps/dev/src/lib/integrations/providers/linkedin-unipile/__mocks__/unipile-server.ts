import {
	type IncomingMessage,
	type ServerResponse,
	createServer as createHttpServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * In-process Unipile mock server for tests, rebuilt against Unipile Hosted
 * Auth v2 + Messaging v2. Starts on a random port so multiple test suites
 * can run in parallel; the caller passes the resolved base URL to the
 * linkedin-unipile client/route via UNIPILE_BASE_URL.
 *
 * Covers the subset of Unipile's v2 API this bet touches:
 *   - POST /v2/auth/link                                    — hosted-auth
 *   - POST /v2/:account_id/chats/send                       — new-chat send
 *   - GET  /v2/:account_id/inboxes/:inbox_id/chats           — list chats
 *   - POST /v2/:account_id/chats/:chat_id/messages/send     — reply in thread
 *   - GET  /v2/:account_id/chats/:chat_id/messages          — read a thread
 *   - GET  /v2/:account_id/users/me/relations               — connections
 *   - POST /v2/:account_id/linkedin/search                  — people search
 *   - GET  /v2/:account_id/users/:identifier                — one profile
 *
 * The v1 handlers (`/api/v1/hosted/accounts/link`, `/api/v1/messages`,
 * `/api/v1/chats*`) are gone. Signature verification is gone too — v2 uses a
 * GET redirect callback whose auth is the round-trip `state` binding, not
 * HMAC; test helpers `simulateCallbackSuccess`/`simulateCallbackError`
 * replace v1's `postSignedCallback`.
 */

export interface UnipileMockServer {
	baseUrl: string
	close: () => Promise<void>
	/** Return the list of inbound requests recorded by the mock so tests can assert on what Unipile received. */
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

// Shapes below are copied from the Unipile v2 reference pages, not invented.
// An invented mock is worse than no mock: it makes the suite green against a
// payload production will never send.

/** `POST /v2/:account_id/chats/send` — reference: "Start a Chat". */
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

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

export async function startUnipileMock(): Promise<UnipileMockServer> {
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

		if (method === 'POST' && url === '/v2/auth/link') {
			const state =
				typeof parsed === 'object' && parsed !== null && 'state' in parsed
					? String((parsed as { state?: unknown }).state ?? '')
					: ''
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
			return send(200, CANNED_AUTH_LINK(state, base))
		}
		// v2 messaging endpoints — account_id is a path segment.
		if (method === 'POST' && /^\/v2\/[^/]+\/chats\/send$/.test(url)) {
			return send(200, CANNED_START_CHAT_RESPONSE())
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
		if (method === 'POST' && /^\/v2\/[^/]+\/linkedin\/search(\?.*)?$/.test(url)) {
			return send(200, CANNED_SEARCH_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/users\/[^/]+(\?.*)?$/.test(url)) {
			return send(200, CANNED_PROFILE_RESPONSE())
		}
		if (method === 'GET' && url.startsWith('/mock-wizard')) {
			res.statusCode = 200
			res.setHeader('Content-Type', 'text/html')
			return res.end('<html><body>mock unipile wizard</body></html>')
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
 * Unipile v2 sends after a hosted-wizard completion. `redirect: 'manual'` so
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
 * Unipile v2 sends on a hosted-wizard failure.
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
