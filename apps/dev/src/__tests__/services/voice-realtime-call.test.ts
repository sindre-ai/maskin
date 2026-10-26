import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
	OpenRealtimeSocketFn,
	RealtimeSocketHandlers,
} from '../../services/voice-realtime-call'

vi.mock('../../lib/analytics/voice-events', () => ({
	captureVoiceToolCall: vi.fn(),
	captureVoiceTurnCompleted: vi.fn(),
}))

const writeLine = vi.fn()
vi.mock('../../services/voice-transcript', () => ({
	writeVoiceTranscriptLine: (...args: unknown[]) => writeLine(...args),
	isTranscriptPersistenceEnabled: vi.fn(async () => true),
}))

const endSession = vi.fn()
const recordTurn = vi.fn()
vi.mock('../../services/voice-session-lifecycle', () => ({
	endVoiceSession: (...args: unknown[]) => endSession(...args),
	recordVoiceTurn: (...args: unknown[]) => recordTurn(...args),
	recordVoiceToolCall: vi.fn(),
}))

vi.mock('../../lib/sentry-voice', () => ({ captureVoiceException: vi.fn() }))

const {
	VOICE_SOCKET_MAX_RECONNECTS,
	attachVoiceCall,
	closeVoiceCall,
	createRealtimeCall,
	realtimeSocketUrl,
} = await import('../../services/voice-realtime-call')

const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const SESSION_ID = '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664'
const session = {
	id: SESSION_ID,
	workspaceId: WORKSPACE,
	agentActorId: AGENT,
	humanActorId: HUMAN,
	conversationId: null,
} as never

function fakeSocket() {
	const sent: Array<Record<string, unknown>> = []
	const close = vi.fn()
	let handlers: RealtimeSocketHandlers | null = null
	let url = ''
	let opens = 0
	const openSocket: OpenRealtimeSocketFn = (u, _key, h) => {
		url = u
		opens += 1
		handlers = h
		return { send: (data) => sent.push(JSON.parse(data)), close }
	}
	return {
		openSocket,
		sent,
		close,
		get url() {
			return url
		},
		get opens() {
			return opens
		},
		open: () => handlers?.onOpen(),
		emit: (evt: Record<string, unknown>) => handlers?.onMessage(JSON.stringify(evt)),
		drop: () => handlers?.onClose(),
	}
}

async function attach(
	socket: ReturnType<typeof fakeSocket>,
	invokeTool = vi.fn(),
	extra: { connectTimeoutMs?: number } = {},
) {
	return attachVoiceCall({
		db: {} as Database,
		session,
		agentName: 'Chief of Staff',
		invokeTool,
		readOnlyTools: new Set(['search_objects']),
		callId: 'rtc_abc',
		apiKey: 'sk-test',
		callsUrl: 'https://api.openai.com/v1/realtime/calls',
		openSocket: socket.openSocket,
		...extra,
	})
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
	writeLine.mockReset()
	endSession.mockReset()
	endSession.mockResolvedValue({})
	recordTurn.mockReset()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('realtimeSocketUrl', () => {
	it('derives the call socket from the calls endpoint', () => {
		expect(realtimeSocketUrl('rtc_abc', 'https://api.openai.com/v1/realtime/calls')).toBe(
			'wss://api.openai.com/v1/realtime?call_id=rtc_abc',
		)
	})
})

describe('attachVoiceCall', () => {
	it('resolves true once the socket opens and connects to the call id', async () => {
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		expect(await attached).toBe(true)
		expect(socket.url).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_abc')
	})

	it('resolves false when the socket stays connecting past the timeout', async () => {
		vi.useFakeTimers()
		const socket = fakeSocket()
		const attached = attach(socket, vi.fn(), { connectTimeoutMs: 5000 })
		await vi.advanceTimersByTimeAsync(5001)
		expect(await attached).toBe(false)
		expect(socket.close).toHaveBeenCalled()
	})

	it('resolves false when the socket closes before opening', async () => {
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.drop()
		expect(await attached).toBe(false)
	})

	it('runs a search_objects call server-side and answers the model with the result, then asks it to speak', async () => {
		const invokeTool = vi.fn().mockResolvedValue({
			content: [{ type: 'text', text: '{"results":[{"title":"Loops v4"}]}' }],
		})
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'call_1',
			name: 'search_objects',
			arguments: JSON.stringify({ q: 'loops v4' }),
		})
		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2))

		expect(invokeTool).toHaveBeenCalledWith(
			'search_objects',
			expect.objectContaining({ q: 'loops v4' }),
			{ actorId: AGENT, workspaceId: WORKSPACE },
		)
		expect(socket.sent[0]).toEqual({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: 'call_1',
				output: '{"results":[{"title":"Loops v4"}]}',
			},
		})
		expect(socket.sent[1]).toEqual({ type: 'response.create' })
	})

	it('holds a risky write until the person says yes over the socket, then runs it once', async () => {
		const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] })
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached
		const call = (id: string, extra: Record<string, unknown> = {}) =>
			socket.emit({
				type: 'response.function_call_arguments.done',
				call_id: id,
				name: 'gmail_send_email',
				arguments: JSON.stringify({ entity_id: 'e1', content: 'hi', ...extra }),
			})

		call('call_1')
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
		expect(invokeTool).not.toHaveBeenCalled()
		const held = (socket.sent[0] as { item: { output: string } }).item.output
		const id = /confirmation_id \\"([^\\"]+)\\"/.exec(held)?.[1]
		expect(id).toBeTruthy()

		socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_yes' })
		socket.emit({
			type: 'conversation.item.input_audio_transcription.completed',
			item_id: 'item_yes',
			transcript: 'Yes, go ahead',
		})
		call('call_2', { confirmation_id: id })
		await vi.waitFor(() => expect(invokeTool).toHaveBeenCalledTimes(1))
	})

	it('asks the model to speak only after the last of several parallel calls is answered', async () => {
		const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		for (const id of ['call_1', 'call_2']) {
			socket.emit({
				type: 'response.function_call_arguments.done',
				call_id: id,
				name: 'search_objects',
				arguments: '{"q":"x"}',
			})
		}
		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
		expect(socket.sent.map((m) => m.type)).toEqual([
			'conversation.item.create',
			'conversation.item.create',
			'response.create',
		])
	})

	it('does not ask the model to speak while the response that made the calls is still active', async () => {
		// Tools answer in milliseconds, long before the model has finished
		// announcing its calls. A response.create then is rejected by OpenAI
		// (conversation_already_has_active_response) and the model speaks from a
		// partial set of results.
		const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		socket.emit({ type: 'response.created' })
		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'call_1',
			name: 'search_objects',
			arguments: '{"q":"x"}',
		})
		await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
		await flush()
		// call_1 is answered but the response is not done: no response.create yet.
		expect(socket.sent.map((m) => m.type)).toEqual(['conversation.item.create'])

		// The model announces a second call before it finishes.
		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'call_2',
			name: 'search_objects',
			arguments: '{"q":"y"}',
		})
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
		expect(socket.sent.map((m) => m.type)).toEqual([
			'conversation.item.create',
			'conversation.item.create',
		])

		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
		expect(socket.sent[2]).toEqual({ type: 'response.create' })
	})

	it('waits for a slow tool after the response is done, then asks the model to speak once', async () => {
		let release: (v: unknown) => void = () => {}
		const invokeTool = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'call_1',
			name: 'search_objects',
			arguments: '{"q":"x"}',
		})
		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		await flush()
		expect(socket.sent).toHaveLength(0)

		release({ content: [{ type: 'text', text: 'ok' }] })
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
		expect(socket.sent.map((m) => m.type)).toEqual(['conversation.item.create', 'response.create'])
	})

	it('persists finished user and assistant turns from the call events', async () => {
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		socket.emit({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: ' search for the loops v4 bet ',
		})
		socket.emit({
			type: 'response.output_audio_transcript.done',
			transcript: 'Loops v4 is active.',
		})
		await vi.waitFor(() => expect(writeLine).toHaveBeenCalledTimes(2))

		expect(writeLine.mock.calls.map(([, args]) => [args.role, args.text])).toEqual([
			['user', 'search for the loops v4 bet'],
			['assistant', 'Loops v4 is active.'],
		])
	})

	it('records a completed turn on response.done, but not for a response that only asked for a tool', async () => {
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		socket.emit({ type: 'response.created' })
		socket.emit({
			type: 'response.done',
			response: { output: [{ type: 'function_call' }] },
		})
		await flush()
		expect(recordTurn).not.toHaveBeenCalled()

		socket.emit({ type: 'response.created' })
		socket.emit({ type: 'response.done', response: { output: [{ type: 'message' }] } })
		await vi.waitFor(() => expect(recordTurn).toHaveBeenCalledTimes(1))
	})

	it('ends the call as network_error once every reconnect attempt has failed, exactly once', async () => {
		vi.useFakeTimers()
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		socket.drop()
		await vi.advanceTimersByTimeAsync(251)
		socket.drop()
		expect(endSession).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1001)
		socket.drop()
		await vi.advanceTimersByTimeAsync(5000)

		expect(endSession).toHaveBeenCalledTimes(1)
		expect(endSession).toHaveBeenCalledWith(expect.anything(), {
			id: SESSION_ID,
			reason: 'network_error',
		})
	})

	it('does not start a second reconnect chain when a failed attempt closes late', async () => {
		vi.useFakeTimers()
		const socket = fakeSocket()
		const attached = attach(socket, vi.fn(), { connectTimeoutMs: 100 })
		socket.open()
		await attached

		socket.drop()
		await vi.advanceTimersByTimeAsync(251) // attempt 1 starts and never opens
		await vi.advanceTimersByTimeAsync(101) // it times out and is closed
		socket.drop() // the closed socket's own close event arrives late
		await vi.advanceTimersByTimeAsync(10_000)

		// The first socket plus the two attempts, not a restarted chain.
		expect(socket.opens).toBe(3)
		expect(endSession).toHaveBeenCalledTimes(1)
	})

	it('ends the call when the socket keeps dropping, instead of reconnecting forever', async () => {
		vi.useFakeTimers()
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		for (let i = 0; i < VOICE_SOCKET_MAX_RECONNECTS; i++) {
			socket.drop()
			await vi.advanceTimersByTimeAsync(251)
			socket.open()
			await vi.advanceTimersByTimeAsync(10)
		}
		expect(endSession).not.toHaveBeenCalled()
		socket.drop()
		await vi.advanceTimersByTimeAsync(10)
		expect(endSession).toHaveBeenCalledTimes(1)
	})

	it('keeps the call when the socket re-opens, and later tool calls still work', async () => {
		vi.useFakeTimers()
		const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		socket.drop()
		await vi.advanceTimersByTimeAsync(251)
		socket.open()
		await vi.advanceTimersByTimeAsync(5000)
		expect(endSession).not.toHaveBeenCalled()

		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'search_objects',
			arguments: '{}',
		})
		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
		expect(invokeTool).toHaveBeenCalledTimes(1)
		expect(socket.sent.map((m) => m.type)).toEqual(['conversation.item.create', 'response.create'])
	})

	it('delivers a tool result finished while the socket was down once it is back', async () => {
		vi.useFakeTimers()
		let release: (v: unknown) => void = () => {}
		const invokeTool = vi.fn().mockReturnValue(
			new Promise((r) => {
				release = r
			}),
		)
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached

		socket.emit({
			type: 'response.function_call_arguments.done',
			call_id: 'c1',
			name: 'search_objects',
			arguments: '{}',
		})
		socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		socket.drop()
		release({ content: [{ type: 'text', text: 'ok' }] })
		await vi.advanceTimersByTimeAsync(100)
		expect(socket.sent).toHaveLength(0)

		await vi.advanceTimersByTimeAsync(200)
		socket.open()
		await vi.advanceTimersByTimeAsync(10)
		expect(socket.sent.map((m) => m.type)).toEqual(['conversation.item.create', 'response.create'])
		expect(endSession).not.toHaveBeenCalled()
	})

	it('does not reconnect when the server closed the socket itself', async () => {
		vi.useFakeTimers()
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		await closeVoiceCall({ voiceSessionId: SESSION_ID, vendorSessionId: null })
		socket.drop()
		await vi.advanceTimersByTimeAsync(5000)
		expect(socket.opens).toBe(1)
		expect(endSession).not.toHaveBeenCalled()
	})

	it('runs a risky call held before the drop once, when the yes comes after the reconnect', async () => {
		vi.useFakeTimers()
		const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] })
		const socket = fakeSocket()
		const attached = attach(socket, invokeTool)
		socket.open()
		await attached
		const args = { entity_id: 'e1', content: 'hello' }
		const call = (id: string, extra: Record<string, unknown> = {}) => {
			socket.emit({
				type: 'response.function_call_arguments.done',
				call_id: id,
				name: 'gmail_send_email',
				arguments: JSON.stringify({ ...args, ...extra }),
			})
			socket.emit({ type: 'response.done', response: { output: [{ type: 'function_call' }] } })
		}

		call('w1')
		await vi.advanceTimersByTimeAsync(10)
		const held = JSON.parse(String((socket.sent[0]?.item as { output: string }).output))
		const confirmationId = /confirmation_id "([^"]+)"/.exec(held.error)?.[1] ?? ''
		expect(confirmationId).not.toBe('')
		expect(invokeTool).not.toHaveBeenCalled()

		socket.drop()
		await vi.advanceTimersByTimeAsync(251)
		socket.open()
		await vi.advanceTimersByTimeAsync(10)
		// The new socket does not replay the hold.
		expect(invokeTool).not.toHaveBeenCalled()

		socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'i1' })
		socket.emit({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: 'yes',
			item_id: 'i1',
		})
		await vi.advanceTimersByTimeAsync(10)
		call('w2', { confirmation_id: confirmationId })
		await vi.advanceTimersByTimeAsync(10)
		call('w3', { confirmation_id: confirmationId })
		await vi.advanceTimersByTimeAsync(10)
		expect(invokeTool).toHaveBeenCalledTimes(1)
	})

	it('does not end the call when the server closes the socket itself', async () => {
		const socket = fakeSocket()
		const attached = attach(socket)
		socket.open()
		await attached

		await closeVoiceCall({ voiceSessionId: SESSION_ID, vendorSessionId: null })
		socket.drop()
		await flush()
		expect(socket.close).toHaveBeenCalled()
		expect(endSession).not.toHaveBeenCalled()
	})
})

describe('closeVoiceCall', () => {
	it('hangs the call up at the vendor with the operator key', async () => {
		process.env.MASKIN_VOICE_OPENAI_API_KEY = 'sk-test'
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		await closeVoiceCall({ voiceSessionId: 'other-session', vendorSessionId: 'rtc_abc' })

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.openai.com/v1/realtime/calls/rtc_abc/hangup',
			expect.objectContaining({
				method: 'POST',
				headers: { Authorization: 'Bearer sk-test' },
			}),
		)
		process.env.MASKIN_VOICE_OPENAI_API_KEY = undefined
	})

	it('does not call the vendor for a session that never got a call', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		await closeVoiceCall({ voiceSessionId: 'x', vendorSessionId: null })
		await closeVoiceCall({ voiceSessionId: 'x', vendorSessionId: 'offer-in-flight' })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('createRealtimeCall — vendor 429', () => {
	const input = {
		apiKey: 'sk-test',
		callsUrl: 'https://api.openai.com/v1/realtime/calls',
		offerSdp: 'v=0',
		instructions: '',
		voice: 'marin',
		model: 'gpt-realtime',
		tools: [],
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('reports a plain rate limit with the Retry-After value and keeps the vendor body', async () => {
		const body = '{"error":{"code":"rate_limit_exceeded"}}'
		const res = new Response(body, { status: 429, headers: { 'retry-after': '12' } })
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))
		expect(await createRealtimeCall(input)).toEqual({
			kind: 'rate_limited',
			retryAfterSeconds: 12,
			vendorBody: body,
		})
	})

	it('falls back to 30 seconds when the vendor sends no Retry-After', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })))
		expect(await createRealtimeCall(input)).toMatchObject({
			kind: 'rate_limited',
			retryAfterSeconds: 30,
		})
	})

	it('keeps a plain rate limit that only links to the billing page as rate_limited', async () => {
		const body =
			'{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached. You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing."}}'
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(new Response(body, { status: 429, headers: { 'retry-after': '9' } })),
		)
		expect(await createRealtimeCall(input)).toMatchObject({
			kind: 'rate_limited',
			retryAfterSeconds: 9,
		})
	})

	it('reports an out-of-quota 429 as quota_exhausted, not a rate limit', async () => {
		const body =
			'{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 429 })))
		expect(await createRealtimeCall(input)).toEqual({ kind: 'quota_exhausted', vendorBody: body })
	})
})
