import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Block = { type: string; text?: string; content?: Block[] }
type Payload = { messages: { content: Block[] }[] }

// The proxy is plain CommonJS shipped in the agent image, not part of this package.
type Ttft = { timeoutMs: number; attemptsPerProvider: number }
type Prefs = Record<string, unknown> | null

const { PLACEHOLDER, stripImages, createProxyServer, readTtftConfig, buildAttemptPlan } =
	createRequire(import.meta.url)('../../../../docker/agent-base/strip-images-proxy.js') as {
		PLACEHOLDER: string
		stripImages: (payload: unknown) => { payload: Payload; count: number }
		createProxyServer: (upstreamBaseUrl: string, providerPrefs?: Prefs, ttft?: Ttft) => Server
		readTtftConfig: (env: Record<string, string>) => Ttft
		buildAttemptPlan: (prefs: Prefs, attemptsPerProvider: number, start?: number) => Prefs[]
	}

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
const note = { type: 'text', text: PLACEHOLDER }

describe('stripImages', () => {
	it('replaces a top-level image and an image nested in a tool_result', () => {
		const { payload, count } = stripImages({
			model: 'deepseek/deepseek-v4-flash-0731',
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'look' }, image] },
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 't1',
							content: [{ type: 'text', text: 'Screenshot taken' }, image],
						},
					],
				},
			],
		})
		expect(count).toBe(2)
		expect(payload.messages[0]?.content).toEqual([{ type: 'text', text: 'look' }, note])
		expect(payload.messages[1]?.content[0]?.content).toEqual([
			{ type: 'text', text: 'Screenshot taken' },
			note,
		])
		expect(JSON.stringify(payload)).not.toContain('"image"')
	})

	it('returns the same object when there is no image', () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] }
		const result = stripImages(body)
		expect(result.count).toBe(0)
		expect(result.payload).toBe(body)
	})
})

describe('strip-images proxy over HTTP', () => {
	const servers: Server[] = []
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
	})

	async function listen(server: Server) {
		servers.push(server)
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
		return (server.address() as AddressInfo).port
	}

	async function startStub(
		respond: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
	) {
		const seen: { url?: string; headers?: IncomingMessage['headers']; body?: Buffer } = {}
		const port = await listen(
			createServer((req, res) => {
				const chunks: Buffer[] = []
				req.on('data', (c) => chunks.push(c))
				req.on('end', () => {
					seen.url = req.url
					seen.headers = req.headers
					seen.body = Buffer.concat(chunks)
					respond(req, seen.body, res)
				})
			}),
		)
		return { seen, port }
	}

	it('strips images, keeps path prefix and auth, and fixes content-length', async () => {
		const stub = await startStub((_req, _body, res) => res.end('ok'))
		const proxyPort = await listen(createProxyServer(`http://127.0.0.1:${stub.port}/api`))
		const body = JSON.stringify({ messages: [{ role: 'user', content: [image] }] })
		const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
			body,
		})
		expect(await res.text()).toBe('ok')
		expect(stub.seen.url).toBe('/api/v1/messages')
		expect(stub.seen.headers?.authorization).toBe('Bearer sk-test')
		const forwarded = stub.seen.body as Buffer
		expect(JSON.parse(forwarded.toString()).messages[0].content).toEqual([note])
		expect(stub.seen.headers?.['content-length']).toBe(String(forwarded.length))
	})

	it('injects provider preferences into a request that holds no images', async () => {
		const stub = await startStub((_req, _body, res) => res.end('ok'))
		const proxyPort = await listen(
			createProxyServer(`http://127.0.0.1:${stub.port}`, { ignore: ['CoreWeave'] }),
		)
		await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		})
		const forwarded = JSON.parse((stub.seen.body as Buffer).toString())
		expect(forwarded.provider).toEqual({ ignore: ['CoreWeave'] })
		expect(forwarded.messages).toEqual([{ role: 'user', content: 'hi' }])
	})

	it('sends no provider field when no preferences are configured', async () => {
		const stub = await startStub((_req, _body, res) => res.end('ok'))
		const proxyPort = await listen(createProxyServer(`http://127.0.0.1:${stub.port}`, null))
		const body = JSON.stringify({ model: 'm', messages: [] })
		await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		})
		expect(stub.seen.body?.toString()).toBe(body)
	})

	it('forwards an unparseable body unchanged', async () => {
		const stub = await startStub((_req, _body, res) => res.end('ok'))
		const proxyPort = await listen(createProxyServer(`http://127.0.0.1:${stub.port}`))
		await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not json',
		})
		expect(stub.seen.body?.toString()).toBe('{not json')
	})

	it('streams the reply chunk by chunk', async () => {
		const stub = await startStub((_req, _body, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' })
			res.write('event: one\n\n')
			setTimeout(() => res.end('event: two\n\n'), 150)
		})
		const proxyPort = await listen(createProxyServer(`http://127.0.0.1:${stub.port}`))
		const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
			method: 'POST',
			body: '{"messages":[]}',
		})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toBe('event: one\n\n')
		const second = await reader.read()
		expect(new TextDecoder().decode(second.value)).toBe('event: two\n\n')
	})

	it('answers 502 when the upstream is unreachable and keeps serving', async () => {
		const dead = createServer()
		const deadPort = await listen(dead)
		await new Promise((r) => dead.close(r))
		const proxyPort = await listen(createProxyServer(`http://127.0.0.1:${deadPort}`))
		const url = `http://127.0.0.1:${proxyPort}/v1/messages`
		const first = await fetch(url, { method: 'POST', body: '{}' })
		const second = await fetch(url, { method: 'POST', body: '{}' })
		expect([first.status, second.status]).toEqual([502, 502])
	})
})

describe('readTtftConfig', () => {
	it('is off unless MASKIN_TTFT_TIMEOUT_MS is a positive number', () => {
		expect(readTtftConfig({}).timeoutMs).toBe(0)
		expect(readTtftConfig({ MASKIN_TTFT_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(0)
		expect(readTtftConfig({ MASKIN_TTFT_TIMEOUT_MS: '0' }).timeoutMs).toBe(0)
	})

	it('defaults to two attempts per provider', () => {
		expect(readTtftConfig({ MASKIN_TTFT_TIMEOUT_MS: '5000' })).toEqual({
			timeoutMs: 5000,
			attemptsPerProvider: 2,
		})
	})
})

describe('buildAttemptPlan', () => {
	it('gives each allowed provider two pinned attempts in turn', () => {
		const plan = buildAttemptPlan({ only: ['digitalocean', 'gmicloud'], ignore: ['x'] }, 2, 0)
		expect(plan).toEqual([
			{ only: ['digitalocean'], ignore: ['x'] },
			{ only: ['digitalocean'], ignore: ['x'] },
			{ only: ['gmicloud'], ignore: ['x'] },
			{ only: ['gmicloud'], ignore: ['x'] },
		])
	})

	it('starts at the given provider', () => {
		const plan = buildAttemptPlan({ only: ['a', 'b'] }, 2, 1)
		expect(plan.map((p) => p?.only)).toEqual([['b'], ['b'], ['a'], ['a']])
	})

	it('retries the same preferences when there is one provider or none', () => {
		expect(buildAttemptPlan({ only: ['a'] }, 2)).toEqual([{ only: ['a'] }, { only: ['a'] }])
		expect(buildAttemptPlan(null, 2)).toEqual([null, null])
	})
})

describe('time-to-first-token guard over HTTP', () => {
	const servers: Server[] = []
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
	})

	async function listen(server: Server) {
		servers.push(server)
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
		return (server.address() as AddressInfo).port
	}

	const FIRST = 'event: message_start\ndata: {}\n\nevent: content_block_start\ndata: {}\n\n'
	const ttft: Ttft = { timeoutMs: 150, attemptsPerProvider: 2 }
	const prefs = { only: ['digitalocean', 'gmicloud'] }
	const sse = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' })

	// respond(n, res): n is the 1-based number of the request the stub received.
	async function setup(
		respond: (n: number, res: ServerResponse) => void,
		guard: Ttft = ttft,
		providerPrefs: Prefs = prefs,
	) {
		const seen: { only?: string[] }[] = []
		const stubPort = await listen(
			createServer((req, res) => {
				const chunks: Buffer[] = []
				req.on('data', (c) => chunks.push(c))
				req.on('end', () => {
					seen.push(JSON.parse(Buffer.concat(chunks).toString()).provider ?? {})
					respond(seen.length, res)
				})
			}),
		)
		const proxyPort = await listen(
			createProxyServer(`http://127.0.0.1:${stubPort}`, providerPrefs, guard),
		)
		const url = `http://127.0.0.1:${proxyPort}/v1/messages`
		const post = (body: object = { stream: true, messages: [] }, signal?: AbortSignal) =>
			fetch(url, { method: 'POST', body: JSON.stringify(body), signal })
		return { seen, post }
	}

	it('passes a fast stream straight through on the first attempt', async () => {
		const { seen, post } = await setup((_n, res) => {
			sse(res)
			res.end(FIRST)
		})
		const res = await post()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(1)
	})

	it('cancels a slow attempt and retries on the same provider', async () => {
		const { seen, post } = await setup((n, res) => {
			sse(res)
			if (n === 1) return // headers sent, no token
			res.end(FIRST)
		})
		const res = await post()
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(2)
		expect(seen[1]?.only).toEqual(seen[0]?.only)
	})

	it('moves to the other provider after two slow attempts, then serves it', async () => {
		const { seen, post } = await setup((n, res) => {
			sse(res)
			if (n <= 2) return
			res.end(FIRST)
		})
		const res = await post()
		expect(await res.text()).toBe(FIRST)
		const providers = seen.map((p) => p.only?.[0])
		expect(providers).toHaveLength(3)
		expect(providers[0]).toBe(providers[1])
		expect(providers[2]).not.toBe(providers[0])
	})

	it('tries providers in order A, A, B, B, with the last try untimed', async () => {
		const { seen, post } = await setup((n, res) => {
			sse(res)
			// The fourth try is slower than the timeout and must still be served.
			if (n === 4) setTimeout(() => res.end(FIRST), ttft.timeoutMs * 2)
		})
		const res = await post()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(FIRST)
		const providers = seen.map((p) => p.only?.[0])
		expect(providers).toHaveLength(4)
		expect(providers[0]).toBe(providers[1])
		expect(providers[2]).toBe(providers[3])
		expect(providers[2]).not.toBe(providers[0])
	})

	it('retries when the stream errors before the first token', async () => {
		const { seen, post } = await setup((n, res) => {
			sse(res)
			if (n === 1) {
				res.write(': keepalive\n\n')
				setTimeout(() => res.destroy(), 20)
				return
			}
			res.end(FIRST)
		})
		const res = await post()
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(2)
	})

	it('passes through a stream that ends without any token event', async () => {
		const { seen, post } = await setup((_n, res) => {
			sse(res)
			res.end(': done\n\n')
		})
		const res = await post()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(': done\n\n')
		expect(seen).toHaveLength(1)
	})

	it('retries when the provider holds the response headers back too', async () => {
		const { seen, post } = await setup((n, res) => {
			if (n === 1) return // no headers at all
			sse(res)
			res.end(FIRST)
		})
		const res = await post()
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(2)
	})

	it('does not time out a stream that has started, however long it runs', async () => {
		const { seen, post } = await setup((_n, res) => {
			sse(res)
			res.write(FIRST)
			setTimeout(() => res.end('event: message_stop\n\n'), 400)
		})
		const res = await post()
		expect(await res.text()).toBe(`${FIRST}event: message_stop\n\n`)
		expect(seen).toHaveLength(1)
	})

	it('passes an error status through without retrying', async () => {
		const { seen, post } = await setup((_n, res) => {
			res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"slow down"}')
		})
		const res = await post()
		expect(res.status).toBe(429)
		expect(seen).toHaveLength(1)
	})

	it('passes an in-stream error event through without retrying', async () => {
		const { seen, post } = await setup((_n, res) => {
			sse(res)
			res.end('event: error\ndata: {"type":"error"}\n\n')
		})
		const res = await post()
		expect(await res.text()).toContain('event: error')
		expect(seen).toHaveLength(1)
	})

	it('leaves non-streaming requests alone', async () => {
		const { seen, post } = await setup((_n, res) => {
			setTimeout(() => res.end('{"ok":true}'), 400)
		})
		const res = await post({ messages: [] })
		expect(await res.text()).toBe('{"ok":true}')
		expect(seen).toHaveLength(1)
	})

	it('does nothing when the guard is off', async () => {
		const { seen, post } = await setup(
			(_n, res) => {
				sse(res)
				setTimeout(() => res.end(FIRST), 400)
			},
			{ timeoutMs: 0, attemptsPerProvider: 0 },
		)
		const res = await post()
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(1)
	})

	it('retries when the connection is reset before any response', async () => {
		const { seen, post } = await setup((n, res) => {
			if (n === 1) return void res.socket?.destroy()
			sse(res)
			res.end(FIRST)
		})
		const res = await post()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(FIRST)
		expect(seen).toHaveLength(2)
	})

	it('answers 502 when the untimed last attempt cannot connect either', async () => {
		const { seen, post } = await setup((_n, res) => res.socket?.destroy())
		const res = await post()
		expect(res.status).toBe(502)
		expect(seen).toHaveLength(4)
	})

	it('drops the upstream call when the client hangs up during the untimed last attempt', async () => {
		let lastClosed = false
		const { seen, post } = await setup((n, res) => {
			sse(res)
			if (n === 4)
				res.on('close', () => {
					lastClosed = true
				})
		})
		const controller = new AbortController()
		const pending = post(undefined, controller.signal).catch(() => 'aborted')
		await vi.waitFor(() => expect(seen).toHaveLength(4), { timeout: 2000 })
		controller.abort()
		await pending
		await vi.waitFor(() => expect(lastClosed).toBe(true), { timeout: 1000 })
	})

	it('stops retrying when the client hangs up', async () => {
		const { seen, post } = await setup((_n, res) => sse(res))
		const controller = new AbortController()
		const pending = post(undefined, controller.signal).then(
			() => 'answered',
			() => 'aborted',
		)
		await new Promise((r) => setTimeout(r, 60))
		controller.abort()
		expect(await pending).toBe('aborted')
		await new Promise((r) => setTimeout(r, 500))
		expect(seen).toHaveLength(1)
	})
})
