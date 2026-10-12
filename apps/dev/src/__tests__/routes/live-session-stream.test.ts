import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { decodeLiveAudioFrame } from '@maskin/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext } from '../setup'

vi.mock('../../services/live-transcript', () => ({
	writeLiveLine: vi.fn(async (_db: unknown, a: { role: string }) => ({
		conversationId: 'conv-1',
		messageId: a.role === 'user' ? 1 : 2,
	})),
	ensureLiveConversation: vi.fn(async () => 'conv-1'),
	isLiveTranscriptEnabled: vi.fn(async () => true),
}))
vi.mock('../../services/live-prompt', () => ({
	buildLiveContext: vi.fn(async () => ({ system: 'sys', history: [] })),
}))
const endLiveSession = vi.fn(async (_db: unknown, i: { id: string }) => ({
	id: i.id,
	startedAt: new Date(Date.now() - 1000),
	endedAt: new Date(),
}))
const startLiveWsGrace = vi.fn()
vi.mock('../../services/live-session-lifecycle', () => ({
	activateLiveSession: vi.fn(async () => {}),
	recordLiveTurn: vi.fn(async () => {}),
	endLiveSession: (db: unknown, i: { id: string }) => endLiveSession(db, i),
	startLiveWsGrace: (...a: unknown[]) => startLiveWsGrace(...a),
	cancelLiveWsGrace: vi.fn(),
}))
vi.mock('../../services/conversation-messages', () => ({
	insertConversationMessage: vi.fn(async () => ({ id: 9 })),
}))
vi.mock('../../lib/openrouter-pricing', () => ({ getModelPricing: vi.fn(async () => null) }))
vi.mock('../../lib/analytics/live-events', () => ({
	trackLiveToolCall: vi.fn(async () => {}),
	trackLiveTurnCompleted: vi.fn(async () => {}),
}))

const { createLiveSessionStreamRoutes } = await import('../../routes/live-session-stream')

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const HUMAN = 'test-actor-id'

const sessionRow = () => ({
	id: SESSION_ID,
	workspaceId: '22222222-2222-4222-8222-222222222222',
	humanActorId: HUMAN,
	agentActorId: '33333333-3333-4333-8333-333333333333',
	conversationId: null,
	status: 'pending',
	inputMode: 'audio',
	turnCount: 0,
})
const agentRow = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'Chief of Staff',
	systemPrompt: null,
	apiKey: 'ank_agent',
	metadata: { live: { enabled: true } },
	llmConfig: null,
}
const wsRow = {
	settings: { llm_keys: { openrouter: 'sk-or-test' } },
	enterpriseGranted: false,
	billingOwnerId: null,
}

const realFetch = globalThis.fetch

function sseBody(): ReadableStream<Uint8Array> {
	const enc = new TextEncoder()
	const chunks = [
		`data: ${JSON.stringify({ choices: [{ delta: { content: 'The retry window is seven days. ' } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: { content: 'Two bets wait on legal.' }, finish_reason: 'stop' }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 } })}\n\n`,
		'data: [DONE]\n\n',
	]
	let i = 0
	return new ReadableStream({
		pull(c) {
			if (i >= chunks.length) return c.close()
			c.enqueue(enc.encode(chunks[i++]))
		},
	})
}

let server: ReturnType<typeof serve>
let port = 0
let ctx: ReturnType<typeof createTestContext>
let flagState: { on: boolean }

beforeAll(async () => {
	ctx = createTestContext()
	const app = new Hono()
	const nodeWs = createNodeWebSocket({ app })
	app.use('*', async (c, next) => {
		c.set('db' as never, ctx.db as never)
		c.set('actorId' as never, HUMAN as never)
		await next()
	})
	app.route(
		'/api/live-sessions',
		createLiveSessionStreamRoutes(nodeWs.upgradeWebSocket, {
			storage: {} as never,
			invokeToolFactory: () => (async () => ({})) as never,
		}),
	)
	server = serve({ fetch: app.fetch, port: 0 })
	nodeWs.injectWebSocket(server)
	await new Promise((r) => server.once('listening', r))
	port = (server.address() as AddressInfo).port
	flagState = { on: true }
})

afterAll(() => {
	server.close()
	globalThis.fetch = realFetch
})

beforeEach(() => {
	process.env.FF_TESTER_ACTOR_IDS = HUMAN
	process.env.FF_TESTER_FEATURES = 'live-mode'
	endLiveSession.mockClear()
	startLiveWsGrace.mockClear()
	ctx.mockResults.selectQueue = [
		[sessionRow()],
		[{ actorId: HUMAN }],
		[agentRow],
		[{ name: 'Sebastian' }],
		[wsRow],
	]
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url)
		if (u.startsWith(`http://localhost:${port}`) || u.startsWith(`http://127.0.0.1:${port}`))
			return realFetch(url, init)
		if (u.includes('/chat/completions')) return new Response(sseBody(), { status: 200 })
		if (u.includes('/audio/speech')) return new Response(new Uint8Array(4800), { status: 200 }) // 100 ms @ 24 kHz
		throw new Error(`unexpected fetch ${u}`)
	}) as typeof fetch
})

function connect(path = `/api/live-sessions/${SESSION_ID}/stream`) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
	ws.binaryType = 'arraybuffer'
	const json: Array<Record<string, unknown>> = []
	const binary: ArrayBuffer[] = []
	ws.addEventListener('message', (e) => {
		if (typeof e.data === 'string') json.push(JSON.parse(e.data))
		else binary.push(e.data as ArrayBuffer)
	})
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener('open', () => resolve())
		ws.addEventListener('error', () => reject(new Error('socket error')))
	})
	const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()))
	return { ws, json, binary, opened, closed }
}

describe('GET /api/live-sessions/:id/stream (real socket)', () => {
	it('connects, runs a spoken turn, and delivers JSON frames and PCM audio in order', async () => {
		const c = connect()
		await c.opened
		await vi.waitFor(() => expect(c.json.map((f) => f.type)).toContain('ready'))
		expect(c.json[0]).toMatchObject({
			type: 'ready',
			llm_model: expect.any(String),
			agent: { name: 'Chief of Staff' },
		})

		c.ws.send(JSON.stringify({ type: 'hello', protocol_version: 1, client: 'ios', speak: true }))
		c.ws.send(JSON.stringify({ type: 'turn.text', client_turn_id: 'a', text: 'Status?' }))
		await vi.waitFor(() => expect(c.json.map((f) => f.type)).toContain('turn.finished'), {
			timeout: 5000,
		})

		const types = c.json.map((f) => f.type)
		expect(types.indexOf('audio.start')).toBeGreaterThan(types.indexOf('assistant.sentence'))
		expect(types.indexOf('audio.end')).toBeLessThan(types.indexOf('turn.finished'))
		const start = c.json.find((f) => f.type === 'audio.start')
		expect(start).toMatchObject({ format: 'pcm_s16le', sample_rate: 24000, channels: 1 })
		expect(c.binary.length).toBeGreaterThan(0)
		const frame = decodeLiveAudioFrame(new Uint8Array(c.binary[0] as ArrayBuffer))
		expect(frame?.header).toMatchObject({ kind: 1, turnIndex: 0, seq: 0 })
		expect(frame?.pcm.length).toBe(4800)
		const fin = c.json.find((f) => f.type === 'turn.finished') as {
			usage: { input_tokens: number; llm_cost_usd: number }
		}
		expect(fin.usage).toMatchObject({ input_tokens: 20, llm_cost_usd: 0.0002 })

		c.ws.send(JSON.stringify({ type: 'end' }))
		await c.closed
		expect(endLiveSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ reason: 'user_hangup' }),
		)
	})

	it('starts the reconnect grace, not an end, when the socket just drops', async () => {
		const c = connect()
		await c.opened
		await vi.waitFor(() => expect(c.json.map((f) => f.type)).toContain('ready'))
		c.ws.close()
		await c.closed
		await vi.waitFor(() => expect(startLiveWsGrace).toHaveBeenCalledOnce())
		expect(endLiveSession).not.toHaveBeenCalled()
	})

	it('refuses before upgrading when the flag is off for the caller', async () => {
		process.env.FF_TESTER_FEATURES = ''
		const res = await realFetch(`http://127.0.0.1:${port}/api/live-sessions/${SESSION_ID}/stream`)
		expect(res.status).toBe(404)
	})

	it('refuses a session that belongs to someone else, as a 404', async () => {
		ctx.mockResults.selectQueue = [[{ ...sessionRow(), humanActorId: 'someone-else' }]]
		const res = await realFetch(`http://127.0.0.1:${port}/api/live-sessions/${SESSION_ID}/stream`)
		expect(res.status).toBe(404)
	})

	it('refuses a session that has already ended', async () => {
		ctx.mockResults.selectQueue = [[{ ...sessionRow(), status: 'ended' }], [{ actorId: HUMAN }]]
		const res = await realFetch(`http://127.0.0.1:${port}/api/live-sessions/${SESSION_ID}/stream`)
		expect(res.status).toBe(409)
	})

	it('refuses when the workspace has no live-capable credentials any more', async () => {
		ctx.mockResults.selectQueue = [
			[sessionRow()],
			[{ actorId: HUMAN }],
			[agentRow],
			[{ name: 'S' }],
			[{ ...wsRow, settings: {}, enterpriseGranted: true }],
		]
		const res = await realFetch(`http://127.0.0.1:${port}/api/live-sessions/${SESSION_ID}/stream`)
		expect(res.status).toBe(409)
	})
})
