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
 *   - GET  /v2/:account_id/chats                            — list chats
 *   - POST /v2/:account_id/chats/:chat_id/messages/send     — reply in thread
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

const CANNED_AUTH_LINK = (state: string, base: string) => ({
	data: {
		link: `${base}/mock-wizard?state=${encodeURIComponent(state)}`,
	},
})

const CANNED_MESSAGE_RESPONSE = () => ({
	object: 'Message',
	id: `mock-msg-${Date.now()}`,
	sent_at: new Date().toISOString(),
})

const CANNED_CHATS_RESPONSE = () => ({
	object: 'ChatList',
	items: [],
	cursor: null,
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
			return send(200, CANNED_MESSAGE_RESPONSE())
		}
		if (method === 'GET' && /^\/v2\/[^/]+\/chats(\?.*)?$/.test(url)) {
			return send(200, CANNED_CHATS_RESPONSE())
		}
		if (method === 'POST' && /^\/v2\/[^/]+\/chats\/[^/]+\/messages\/send$/.test(url)) {
			return send(200, CANNED_MESSAGE_RESPONSE())
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
