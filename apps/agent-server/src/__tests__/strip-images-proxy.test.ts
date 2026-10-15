import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

type Block = { type: string; text?: string; content?: Block[] }
type Payload = { messages: { content: Block[] }[] }

// The proxy is plain CommonJS shipped in the agent image, not part of this package.
const { PLACEHOLDER, stripImages, createProxyServer } = createRequire(import.meta.url)(
	'../../../../docker/agent-base/strip-images-proxy.js',
) as {
	PLACEHOLDER: string
	stripImages: (payload: unknown) => { payload: Payload; count: number }
	createProxyServer: (
		upstreamBaseUrl: string,
		providerPrefs?: Record<string, unknown> | null,
	) => Server
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
