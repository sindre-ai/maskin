import { createHmac } from 'node:crypto'
import {
	type IncomingMessage,
	type ServerResponse,
	createServer as createHttpServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * In-process Unipile mock server for tests. Starts on a random port so
 * multiple test suites can run in parallel; the caller passes the resolved
 * base URL to the linkedin-unipile client / route via UNIPILE_BASE_URL.
 *
 * Covers the subset of Unipile's API surface this bet touches:
 *   - POST /api/v1/hosted/accounts/link  — Task 2 (this task)
 *   - POST /api/v1/messages              — Task 3
 *   - GET  /api/v1/chats                 — Task 3
 *   - POST /api/v1/chats/:id/messages    — Task 3
 *
 * Task 3 hydrates the messaging responses; the current file returns
 * canned success shapes for all four routes so a Task 3 driver doesn't
 * have to touch the mock again.
 *
 * The mock also exposes `postSignedCallback(url, body)` — a test helper
 * that computes a valid HMAC-SHA256 signature over `body` using the same
 * secret the linkedin-unipile route reads, then POSTs it to `url`. This
 * lets tests drive the Unipile → Maskin webhook leg without duplicating
 * signature-generation logic in every test file.
 */

export interface UnipileMockServer {
	baseUrl: string
	close: () => Promise<void>
	/** Return the list of inbound requests recorded by the mock so tests can assert on what Unipile received. */
	inbox: () => Array<{ method: string; path: string; body: unknown }>
	/** Reset the recorded inbox between test cases. */
	resetInbox: () => void
}

const CANNED_HOSTED_LINK = (name: string, base: string) => ({
	object: 'HostedAuthUrl',
	url: `${base}/mock-wizard?integration=${encodeURIComponent(name)}`,
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

		if (method === 'POST' && url === '/api/v1/hosted/accounts/link') {
			const name =
				typeof parsed === 'object' && parsed !== null && 'name' in parsed
					? String((parsed as { name?: unknown }).name ?? '')
					: ''
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
			return send(200, CANNED_HOSTED_LINK(name, base))
		}
		if (method === 'POST' && url === '/api/v1/messages') {
			return send(200, CANNED_MESSAGE_RESPONSE())
		}
		if (method === 'GET' && url.startsWith('/api/v1/chats')) {
			return send(200, CANNED_CHATS_RESPONSE())
		}
		if (method === 'POST' && /^\/api\/v1\/chats\/[^/]+\/messages$/.test(url)) {
			return send(200, CANNED_MESSAGE_RESPONSE())
		}
		if (method === 'GET' && url === '/mock-wizard') {
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
 * Test helper: POST a JSON body to a Maskin callback URL with a valid
 * HMAC-SHA256 signature computed against `secret`. Keeps signature-generation
 * out of every test file.
 */
export async function postSignedCallback(
	url: string,
	body: unknown,
	secret: string,
	options: { headerName?: string } = {},
): Promise<Response> {
	const rawBody = JSON.stringify(body)
	const signature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
	const headerName = options.headerName ?? 'X-Unipile-Signature'
	return fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[headerName]: signature,
		},
		body: rawBody,
	})
}
