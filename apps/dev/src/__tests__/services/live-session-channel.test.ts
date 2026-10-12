import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../lib/llm/openai-stream'
import type { TtsAudio } from '../../services/live-tts'

const writeLiveLine = vi.fn(async (_db: unknown, a: { role: string }) => ({
	conversationId: 'conv-1',
	messageId: a.role === 'user' ? 1 : 2,
}))
const recordLiveTurn = vi.fn(async () => {})
const endLiveSession = vi.fn(async (_db: unknown, i: { id: string }) => ({
	id: i.id,
	startedAt: new Date(Date.now() - 5000),
	endedAt: new Date(),
}))

vi.mock('../../services/live-transcript', () => ({
	writeLiveLine: (db: unknown, a: { role: string }) => writeLiveLine(db, a),
	ensureLiveConversation: vi.fn(async () => 'conv-1'),
	isLiveTranscriptEnabled: vi.fn(async () => true),
}))
vi.mock('../../services/live-session-lifecycle', () => ({
	activateLiveSession: vi.fn(async () => {}),
	recordLiveTurn: (...a: unknown[]) => recordLiveTurn(...(a as [])),
	endLiveSession: (db: unknown, i: { id: string }) => endLiveSession(db, i),
}))
vi.mock('../../services/live-prompt', () => ({
	buildLiveContext: vi.fn(async () => ({ system: 'sys', history: [] })),
}))
vi.mock('../../services/conversation-messages', () => ({
	insertConversationMessage: vi.fn(async () => ({ id: 9 })),
}))
vi.mock('../../lib/openrouter-pricing', () => ({ getModelPricing: vi.fn(async () => null) }))
vi.mock('../../lib/analytics/live-events', () => ({
	trackLiveToolCall: vi.fn(async () => {}),
	trackLiveTurnCompleted: vi.fn(async () => {}),
}))

const { createLiveChannel } = await import('../../services/live-session-channel')
const { PlanCapExceededError } = await import('../../lib/llm-routing')

const text = (delta: string): ChatStreamEvent => ({ type: 'text', delta })
const finish = (): ChatStreamEvent => ({ type: 'finish', reason: 'stop' })

function audio(): TtsAudio {
	return {
		sampleRate: 24000,
		channels: 1,
		bitsPerSample: 16,
		pcm: (async function* () {
			yield new Uint8Array([1, 0, 2, 0])
		})(),
	}
}

function harness(
	over: {
		script?: ChatStreamEvent[]
		checkPlanCap?: () => Promise<void>
		opening?: 'briefing'
	} = {},
) {
	const json: Array<Record<string, unknown>> = []
	const binary: Uint8Array[] = []
	let closed = false
	const channel = createLiveChannel({
		db: {} as never,
		storage: {} as never,
		session: {
			id: 'live-1',
			workspaceId: 'ws-1',
			humanActorId: 'h-1',
			agentActorId: 'a-1',
			conversationId: null,
			inputMode: 'audio',
			turnCount: 0,
		} as never,
		agent: { id: 'a-1', name: 'Chief of Staff', systemPrompt: null },
		human: { id: 'h-1', name: 'Sebastian' },
		creds: {
			apiKey: 'k',
			baseUrl: 'https://openrouter.ai/api/v1',
			route: 'workspace_openrouter_key',
			llmModel: 'a/b',
			ttsModel: 'tts/x',
			ttsVoice: 'alloy',
			sttModel: 'stt/x',
		},
		io: {
			sendJson: (f) => json.push(f),
			sendBinary: (d) => binary.push(d),
			waitForDrain: async () => {},
			close: () => {
				closed = true
			},
		},
		opening: over.opening,
		tools: [],
		invokeTool: vi.fn(async () => ({})),
		parseArgs: (_n, raw) => (raw ?? {}) as Record<string, unknown>,
		riskOf: () => 'read',
		label: (n) => n,
		checkPlanCap: over.checkPlanCap ?? (async () => {}),
		stream: async function* (p) {
			for (const ev of over.script ?? [
				text('Hello there, this is a full sentence. '),
				text('And a second one follows it.'),
				finish(),
			]) {
				if (p.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
				yield ev
			}
		},
		synthesize: async () => audio(),
	})
	const types = () => json.map((f) => f.type)
	const settle = async () => {
		await vi.waitFor(() => expect(types()).toContain('turn.finished'), { timeout: 2000 })
	}
	return { channel, json, binary, types, settle, isClosed: () => closed }
}

const send = (h: ReturnType<typeof harness>, frame: Record<string, unknown>) =>
	h.channel.onMessage(JSON.stringify(frame))

describe('live session channel', () => {
	beforeEach(() => {
		writeLiveLine.mockClear()
		recordLiveTurn.mockClear()
		endLiveSession.mockClear()
	})

	it('opens with ready carrying the conversation and voice', async () => {
		const h = harness()
		await h.channel.onOpen()
		expect(h.json[0]).toMatchObject({
			type: 'ready',
			live_session_id: 'live-1',
			conversation_id: 'conv-1',
			tts: { voice: 'alloy' },
		})
	})

	it('runs a spoken turn in protocol order and persists both sides', async () => {
		const h = harness()
		await h.channel.onOpen()
		await send(h, { type: 'turn.text', client_turn_id: 'c1', text: 'How are we doing?' })
		await h.settle()
		const t = h.types()
		const order = [
			'turn.started',
			'transcript.user',
			'assistant.delta',
			'assistant.sentence',
			'audio.start',
			'audio.sentence_end',
			'audio.end',
			'turn.finished',
		]
		const idx = order.map((x) => t.indexOf(x))
		expect(idx.every((i) => i >= 0)).toBe(true)
		expect(idx[0]).toBeLessThan(idx[1] as number)
		expect(t.indexOf('audio.start')).toBeLessThan(t.indexOf('audio.end'))
		expect(t.indexOf('audio.end')).toBeLessThan(t.indexOf('turn.finished'))
		expect(h.binary.length).toBeGreaterThan(0)
		const roles = writeLiveLine.mock.calls.map((c) => (c[1] as { role: string }).role)
		expect(roles).toEqual(expect.arrayContaining(['user', 'assistant']))
		expect(recordLiveTurn).toHaveBeenCalled()
		const fin = h.json.find((f) => f.type === 'turn.finished')
		expect(fin).toMatchObject({ interrupted: false, message_id: 2 })
	})

	it('skips audio entirely when the client asked for text only', async () => {
		const h = harness()
		await h.channel.onOpen()
		await send(h, { type: 'hello', protocol_version: 1, client: 'web', speak: false })
		await send(h, { type: 'turn.text', client_turn_id: 'c1', text: 'Hi' })
		await h.settle()
		expect(h.types()).not.toContain('audio.start')
		expect(h.binary).toHaveLength(0)
		expect(h.types()).toContain('assistant.sentence')
	})

	it('rejects a client speaking another protocol version', async () => {
		const h = harness()
		await h.channel.onOpen()
		await send(h, { type: 'hello', protocol_version: 99, client: 'ios', speak: true })
		expect(h.json.at(-1)).toMatchObject({ type: 'error', code: 'unsupported_protocol' })
		expect(h.isClosed()).toBe(true)
	})

	it('answers ping and refuses malformed or unknown frames without dying', async () => {
		const h = harness()
		await h.channel.onOpen()
		await send(h, { type: 'ping' })
		await h.channel.onMessage('not json')
		await send(h, { type: 'nope' })
		expect(h.types().slice(-3)).toEqual(['pong', 'error', 'error'])
	})

	it('tells the client server-side speech input is not enabled instead of ignoring it', async () => {
		const h = harness()
		await h.channel.onOpen()
		await send(h, { type: 'turn.audio.start', client_turn_id: 'c', format: 'pcm_s16le' })
		expect(h.json.at(-1)).toMatchObject({ type: 'error', code: 'stt_failed' })
	})

	it('interrupting a running turn ends it as interrupted and keeps only what was heard', async () => {
		let release!: () => void
		const gate = new Promise<void>((r) => {
			release = r
		})
		const h = harness()
		// Replace the stream with one that pauses after the first sentence.
		const slow = createSlow(gate)
		const ch = slow.channel
		await ch.onOpen()
		await ch.onMessage(
			JSON.stringify({ type: 'turn.text', client_turn_id: 'c1', text: 'Tell me everything' }),
		)
		await vi.waitFor(() => expect(slow.types()).toContain('audio.sentence_end'))
		const end = slow.json.find((f) => f.type === 'audio.sentence_end') as { last_seq: number }
		await ch.onMessage(
			JSON.stringify({ type: 'interrupt', turn_index: 0, played_seq: end.last_seq }),
		)
		release()
		await vi.waitFor(() => expect(slow.types()).toContain('turn.finished'), { timeout: 2000 })
		const fin = slow.json.find((f) => f.type === 'turn.finished')
		expect(fin).toMatchObject({ interrupted: true })
		void h
		const assistant = writeLiveLine.mock.calls
			.map((c) => c[1] as { role: string; text: string; interrupted?: boolean })
			.filter((a) => a.role === 'assistant')
			.at(-1)
		expect(assistant?.interrupted).toBe(true)
		expect(assistant?.text).toBe('The first sentence is long enough.')
	})

	it('ends the call and tells the client when the plan cap is reached', async () => {
		const h = harness({
			checkPlanCap: async () => {
				throw new PlanCapExceededError({ plan: 'pro', used: 2, cap: 1, periodEnd: null })
			},
		})
		await h.channel.onOpen()
		await send(h, { type: 'turn.text', client_turn_id: 'c', text: 'Hi' })
		await vi.waitFor(() => expect(h.types()).toContain('ended'))
		expect(h.json.some((f) => f.type === 'error' && f.code === 'plan_cap_exceeded')).toBe(true)
		expect(h.json.find((f) => f.type === 'ended')).toMatchObject({ reason: 'plan_cap' })
		expect(endLiveSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ reason: 'plan_cap' }),
		)
	})

	it('ends on request, once', async () => {
		const h = harness()
		await h.channel.onOpen()
		endLiveSession.mockClear()
		await send(h, { type: 'end' })
		await send(h, { type: 'end' })
		expect(endLiveSession).toHaveBeenCalledTimes(1)
		expect(h.json.filter((f) => f.type === 'ended')).toHaveLength(1)
		expect(h.channel.ended).toBe(true)
	})

	it('does not echo the synthetic opening line back as a user transcript', async () => {
		const h = harness({ opening: 'briefing' })
		await h.channel.onOpen()
		await h.settle()
		expect(h.types()).not.toContain('transcript.user')
		const roles = writeLiveLine.mock.calls.map((c) => (c[1] as { role: string }).role)
		expect(roles.filter((r) => r === 'user')).toHaveLength(0)
	})
})

/** A harness whose model emits one sentence, then waits on `gate` before a second. */
function createSlow(gate: Promise<void>) {
	const json: Array<Record<string, unknown>> = []
	const channel = createLiveChannel({
		db: {} as never,
		storage: {} as never,
		session: {
			id: 'live-2',
			workspaceId: 'ws-1',
			humanActorId: 'h-1',
			agentActorId: 'a-1',
			conversationId: null,
			inputMode: 'audio',
			turnCount: 0,
		} as never,
		agent: { id: 'a-1', name: 'CoS', systemPrompt: null },
		human: { id: 'h-1', name: 'S' },
		creds: {
			apiKey: 'k',
			baseUrl: 'https://openrouter.ai/api/v1',
			route: 'workspace_openrouter_key',
			llmModel: 'a/b',
			ttsModel: 't',
			ttsVoice: 'v',
			sttModel: 's',
		},
		io: {
			sendJson: (f) => json.push(f),
			sendBinary: () => {},
			waitForDrain: async () => {},
			close: () => {},
		},
		tools: [],
		invokeTool: vi.fn(async () => ({})),
		parseArgs: (_n, r) => (r ?? {}) as Record<string, unknown>,
		riskOf: () => 'read',
		label: (n) => n,
		checkPlanCap: async () => {},
		stream: async function* (p) {
			yield text('The first sentence is long enough. ')
			yield text('Second ')
			// Like a real fetch, stop as soon as the signal fires; otherwise wait for the gate.
			await Promise.race([
				gate,
				new Promise<void>((_, reject) =>
					p.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					),
				),
			])
			yield text('sentence continues here for a while. ')
			yield finish()
		},
		synthesize: async () => audio(),
	})
	return { channel, json, types: () => json.map((f) => f.type) }
}
