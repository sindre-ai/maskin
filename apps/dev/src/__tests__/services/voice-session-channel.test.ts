import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureToolCall = vi.fn()
const captureTurnCompleted = vi.fn()
const captureCardAction = vi.fn()
vi.mock('../../lib/analytics/voice-events', () => ({
	captureForYouCardActionByVoice: (...args: unknown[]) => captureCardAction(...args),
	captureVoiceToolCall: (...args: unknown[]) => captureToolCall(...args),
	captureVoiceTurnCompleted: (...args: unknown[]) => captureTurnCompleted(...args),
}))

const writeLine = vi.fn()
const persistenceEnabled = vi.fn()
vi.mock('../../services/voice-transcript', () => ({
	writeVoiceTranscriptLine: (...args: unknown[]) => writeLine(...args),
	isTranscriptPersistenceEnabled: (...args: unknown[]) => persistenceEnabled(...args),
}))

const endSession = vi.fn()
const recordTurn = vi.fn()
const recordToolCall = vi.fn()
vi.mock('../../services/voice-session-lifecycle', () => ({
	endVoiceSession: (...args: unknown[]) => endSession(...args),
	recordVoiceTurn: (...args: unknown[]) => recordTurn(...args),
	recordVoiceToolCall: (...args: unknown[]) => recordToolCall(...args),
}))

const captureException = vi.fn()
vi.mock('../../lib/sentry-voice', () => ({
	captureVoiceException: (...args: unknown[]) => captureException(...args),
}))

const showInChat = vi.fn()
vi.mock('../../services/voice-show-in-chat', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/voice-show-in-chat')>()),
	showInChat: (...args: unknown[]) => showInChat(...args),
}))

const buildHoldPreview = vi.fn()
const postHoldPreview = vi.fn()
vi.mock('../../services/voice-hold-preview', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/voice-hold-preview')>()),
	buildHoldPreview: (...args: unknown[]) => buildHoldPreview(...args),
	postHoldPreview: (...args: unknown[]) => postHoldPreview(...args),
}))

const describeToolCall = vi.fn()
const postReceiptLine = vi.fn()
vi.mock('../../services/voice-receipt', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/voice-receipt')>()),
	describeToolCall: (...args: unknown[]) => describeToolCall(...args),
	postReceiptLine: (...args: unknown[]) => postReceiptLine(...args),
}))

const { createVoiceChannel } = await import('../../services/voice-session-channel')
const { dropVoiceCallState, peekVoiceCallState, voiceCallState } = await import(
	'../../services/voice-call-state'
)
type Channel = ReturnType<typeof createVoiceChannel>

const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const OTHER_WORKSPACE = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60'
const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const SESSION_ID = '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664'
const ENTITY = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'

const session = {
	id: SESSION_ID,
	workspaceId: WORKSPACE,
	agentActorId: AGENT,
	humanActorId: HUMAN,
	conversationId: null,
} as never

const RECEIPT_CHAT = 'a0e1f2a3-b4c5-4d6e-8f70-81920a3b4c5d'
const HOLD_CHAT = '9fd17e80-fb03-4587-a1c4-b0d3c57e0aa8'
const heldPreview = (fingerprint: string, body = 'Hello Lars, can we meet on Tuesday?') => ({
	summary: 'Send this email',
	recipients: ['Lars Honoré <lars@example.dk>'],
	subject: 'Meeting',
	body,
	note: null,
	fingerprint,
})

const READ_ONLY = new Set(['search_objects', 'list_objects', 'get_objects', 'list_actors'])

function setup(invokeTool = vi.fn()) {
	const sent: Array<Record<string, unknown>> = []
	const channel: Channel = createVoiceChannel({
		db: {} as Database,
		session,
		agentName: 'Chief of Staff',
		invokeTool,
		isReadOnlyTool: (name) => READ_ONLY.has(name),
		send: (m) => sent.push(m as Record<string, unknown>),
		now: (() => {
			let t = 1_000
			return () => {
				t += 25
				return t
			}
		})(),
	})
	const toolCall = (name: string, args: unknown, callId = 'call_1') =>
		channel.onMessage(
			JSON.stringify({
				type: 'tool_call',
				call_id: callId,
				name,
				arguments: typeof args === 'string' ? args : JSON.stringify(args),
			}),
		)
	return { channel, sent, invokeTool, toolCall }
}

const textResult = (text: string) => ({ content: [{ type: 'text', text }] })
const lastResult = (sent: Array<Record<string, unknown>>) =>
	sent.find((m) => m.type === 'tool_result') as {
		ok: boolean
		error_code: string | null
		call_id: string
		event: { type: string; item: { type: string; call_id: string; output: string } }
	}

beforeEach(() => {
	captureToolCall.mockReset()
	captureTurnCompleted.mockReset()
	captureCardAction.mockReset()
	dropVoiceCallState(SESSION_ID)
	// No lines by default, so the older tests see no receipt traffic; the receipt tests set a draft.
	describeToolCall.mockReset().mockResolvedValue([])
	postReceiptLine.mockReset().mockResolvedValue(RECEIPT_CHAT)
	endSession.mockReset().mockResolvedValue({})
	recordTurn.mockReset()
	recordToolCall.mockReset()
	captureException.mockReset()
	writeLine.mockReset()
	showInChat.mockReset()
	buildHoldPreview.mockReset().mockResolvedValue(heldPreview('v1'))
	postHoldPreview.mockReset().mockResolvedValue(HOLD_CHAT)
	persistenceEnabled.mockReset().mockResolvedValue(true)
})

describe('voice channel — open', () => {
	it('announces whether transcripts persist and any existing conversation', async () => {
		persistenceEnabled.mockResolvedValue(false)
		const { channel, sent } = setup()
		await channel.onOpen()
		expect(sent).toEqual([{ type: 'ready', persist_transcripts: false, conversation_id: null }])
	})
})

describe('voice channel — tool proxy', () => {
	it('runs a read through invokeTool as the agent and returns a function_call_output', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue(textResult('{"results":[{"title":"Loops v4 polish"}]}'))
		const { sent, toolCall } = setup(invoke)
		await toolCall('search_objects', { q: 'loops v4 bet' })

		expect(invoke).toHaveBeenCalledTimes(1)
		const [name, args, ctx] = invoke.mock.calls[0] as [string, Record<string, unknown>, unknown]
		expect(name).toBe('search_objects')
		expect(args).toMatchObject({ q: 'loops v4 bet', workspace_id: WORKSPACE })
		expect(ctx).toEqual({ actorId: AGENT, workspaceId: WORKSPACE })

		const result = lastResult(sent)
		expect(result).toMatchObject({ ok: true, error_code: null, call_id: 'call_1' })
		expect(result.event).toEqual({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: 'call_1',
				output: '{"results":[{"title":"Loops v4 polish"}]}',
			},
		})
	})

	it('fills in workspace_id when the model leaves it out, and overrides one it passes', async () => {
		const invoke = vi.fn().mockResolvedValue(textResult('ok'))
		const { toolCall } = setup(invoke)
		await toolCall('list_objects', { type: 'bet', cursor: 'abc' })
		await toolCall('list_objects', { workspace_id: OTHER_WORKSPACE }, 'call_2')
		expect(invoke.mock.calls[0]?.[1]).toEqual({
			workspace_id: WORKSPACE,
			type: 'bet',
			cursor: 'abc',
		})
		expect(invoke.mock.calls[1]?.[1]).toEqual({ workspace_id: WORKSPACE })
		expect(invoke.mock.calls[1]?.[2]).toMatchObject({ workspaceId: WORKSPACE })
	})

	it('answers unparseable arguments without calling the tool', async () => {
		const invoke = vi.fn()
		const { sent, toolCall } = setup(invoke)
		await toolCall('search_objects', '{not json')
		expect(invoke).not.toHaveBeenCalled()
		expect(lastResult(sent)).toMatchObject({ ok: false, error_code: 'voice_tool_failed' })
	})

	it('reports a tool that returns isError as a failed call', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'bad status' }] })
		const { sent, toolCall } = setup(invoke)
		await toolCall('get_objects', { ids: [ENTITY] })
		expect(lastResult(sent)).toMatchObject({ ok: false, error_code: 'voice_tool_failed' })
	})

	it('survives a thrown tool error and tells the model, without dropping the socket', async () => {
		const invoke = vi.fn().mockRejectedValue(new Error('API 500: boom'))
		const { sent, toolCall } = setup(invoke)
		await expect(toolCall('search_objects', { q: 'x' })).resolves.toBeUndefined()
		const result = lastResult(sent)
		expect(result).toMatchObject({ ok: false, error_code: 'voice_tool_failed' })
		expect(JSON.parse(result.event.item.output).error).toContain('API 500: boom')
	})

	it('passes structuredContent to the model when a tool returns no text', async () => {
		const structured = { heroCard: { kind: 'list', tool: 'list_actors', objects: [{ id: 'a1' }] } }
		const invoke = vi.fn().mockResolvedValue({ content: [], structuredContent: structured })
		const { sent, toolCall } = setup(invoke)
		await toolCall('list_actors', {})
		const result = lastResult(sent)
		expect(result.ok).toBe(true)
		expect(JSON.parse(result.event.item.output)).toEqual(structured)
	})

	it('caps an oversized result so one read cannot flood a Realtime turn', async () => {
		const invoke = vi.fn().mockResolvedValue(textResult('x'.repeat(50_000)))
		const { sent, toolCall } = setup(invoke)
		await toolCall('get_objects', { ids: [ENTITY] })
		const output = lastResult(sent).event.item.output
		expect(output.length).toBeLessThan(21_000)
		expect(output.endsWith('[truncated]')).toBe(true)
	})

	it('fires voice_tool_call once per invocation with the spec properties, success and refusal', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(textResult('ok'))
			.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'nope' }] })
		const { toolCall } = setup(invoke)
		await toolCall('search_objects', { q: 'x' })
		await toolCall('get_objects', { ids: [ENTITY] }, 'call_2')

		expect(captureToolCall).toHaveBeenCalledTimes(2)
		expect(captureToolCall).toHaveBeenNthCalledWith(1, HUMAN, {
			voice_session_id: SESSION_ID,
			tool_name: 'search_objects',
			success: true,
			latency_ms: 25,
			error_code: null,
		})
		expect(captureToolCall).toHaveBeenNthCalledWith(2, HUMAN, {
			voice_session_id: SESSION_ID,
			tool_name: 'get_objects',
			success: false,
			latency_ms: expect.any(Number),
			error_code: 'voice_tool_failed',
		})
	})
})

describe('voice channel — transcript', () => {
	const line = (role: string, text: string) => JSON.stringify({ type: 'transcript', role, text })

	it('writes lines one at a time in arrival order', async () => {
		const order: string[] = []
		writeLine.mockImplementation(async (_db, args: { text: string }) => {
			// The first write is slower; a concurrent writer would finish it last.
			await new Promise((r) => setTimeout(r, args.text === 'first' ? 20 : 0))
			order.push(args.text)
			return { conversationId: 'conv-1', messageId: order.length }
		})
		const { channel } = setup()
		await channel.onMessage(line('user', 'first'))
		await channel.onMessage(line('assistant', 'second'))
		await channel.onMessage(line('user', 'third'))
		await channel.idle()
		expect(order).toEqual(['first', 'second', 'third'])
	})

	it('passes the role, agent name and session through, and announces the conversation once', async () => {
		writeLine.mockResolvedValue({ conversationId: 'conv-1', messageId: 1 })
		const { channel, sent } = setup()
		await channel.onMessage(line('user', 'hello'))
		await channel.onMessage(line('assistant', 'hi there'))
		await channel.idle()

		expect(writeLine.mock.calls[0]?.[1]).toMatchObject({
			role: 'user',
			text: 'hello',
			agentName: 'Chief of Staff',
			session: { id: SESSION_ID },
		})
		expect(writeLine.mock.calls[1]?.[1]).toMatchObject({ role: 'assistant', text: 'hi there' })
		expect(sent.filter((m) => m.type === 'conversation')).toEqual([
			{ type: 'conversation', conversation_id: 'conv-1' },
		])
	})

	it('announces nothing when the writer wrote nothing (workspace opted out)', async () => {
		writeLine.mockResolvedValue(null)
		const { channel, sent } = setup()
		await channel.onMessage(line('user', 'hello'))
		await channel.idle()
		expect(sent.filter((m) => m.type === 'conversation')).toEqual([])
		expect(sent.filter((m) => m.type === 'error')).toEqual([])
	})

	it('reports a failed write and keeps writing later lines', async () => {
		writeLine
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce({ conversationId: 'conv-1', messageId: 2 })
		const { channel, sent } = setup()
		await channel.onMessage(line('user', 'one'))
		await channel.onMessage(line('user', 'two'))
		await channel.idle()
		expect(sent.filter((m) => m.type === 'error')).toEqual([
			{ type: 'error', code: 'voice_transcript_failed' },
		])
		expect(sent.filter((m) => m.type === 'conversation')).toHaveLength(1)
	})
})

describe('voice channel — turn telemetry and frame handling', () => {
	it('fires voice_turn_completed with barge_in propagated', async () => {
		const { channel } = setup()
		await channel.onMessage(
			JSON.stringify({
				type: 'turn_completed',
				turn_index: 4,
				user_audio_ms: 800,
				agent_audio_ms: 210,
				barge_in: true,
			}),
		)
		expect(captureTurnCompleted).toHaveBeenCalledWith(HUMAN, {
			voice_session_id: SESSION_ID,
			turn_index: 4,
			user_audio_ms: 800,
			agent_audio_ms: 210,
			barge_in: true,
		})
	})

	it('answers junk frames with an error instead of throwing', async () => {
		const { channel, sent } = setup()
		for (const raw of [
			'not json',
			'{}',
			JSON.stringify({ type: 'unknown' }),
			JSON.stringify({ type: 'transcript', role: 'system', text: 'x' }),
			JSON.stringify({ type: 'turn_completed', turn_index: -1 }),
			new ArrayBuffer(4),
			'x'.repeat(300_000),
		]) {
			await expect(channel.onMessage(raw)).resolves.toBeUndefined()
		}
		expect(sent.every((m) => m.type === 'error' && m.code === 'voice_invalid_message')).toBe(true)
		expect(sent).toHaveLength(7)
		expect(writeLine).not.toHaveBeenCalled()
	})
})

describe('voice channel — session lifecycle hooks', () => {
	it('keeps the call going when a counter write fails', async () => {
		recordTurn.mockRejectedValueOnce(new Error('db down'))
		recordToolCall.mockRejectedValueOnce(new Error('db down'))
		const { channel, sent, toolCall } = setup(vi.fn().mockResolvedValue(textResult('ok')))
		await channel.onMessage(
			JSON.stringify({
				type: 'turn_completed',
				turn_index: 0,
				user_audio_ms: 1_000,
				agent_audio_ms: 1_000,
				barge_in: false,
			}),
		)
		await toolCall('search_objects', { query: 'loops', workspace_id: WORKSPACE })
		expect(sent.some((m) => m.type === 'tool_result' && m.ok === true)).toBe(true)
	})

	it('records each turn and each tool call against the session counters', async () => {
		const { channel, toolCall } = setup(vi.fn().mockResolvedValue(textResult('ok')))
		await channel.onMessage(
			JSON.stringify({
				type: 'turn_completed',
				turn_index: 0,
				user_audio_ms: 4_000,
				agent_audio_ms: 9_000,
				barge_in: false,
			}),
		)
		await toolCall('search_objects', { query: 'loops', workspace_id: WORKSPACE })
		expect(recordTurn).toHaveBeenCalledWith(expect.anything(), SESSION_ID, {
			userAudioMs: 4_000,
			agentAudioMs: 9_000,
		})
		expect(recordToolCall).toHaveBeenCalledWith(expect.anything(), SESSION_ID)
	})

	it('ends the call as vendor_error, tags Sentry with the session id, and tells the browser', async () => {
		const { channel, sent } = setup()
		await channel.onMessage(
			JSON.stringify({ type: 'vendor_error', code: 'server_error', message: 'upstream blew up' }),
		)
		expect(endSession).toHaveBeenCalledWith(expect.anything(), {
			id: SESSION_ID,
			reason: 'vendor_error',
			vendorErrorCode: 'server_error',
		})
		expect(captureException).toHaveBeenCalledWith(SESSION_ID, expect.any(Error))
		expect(sent).toContainEqual({ type: 'ended', reason: 'vendor_error' })
	})

	it('stays silent to the browser when the call had already ended', async () => {
		endSession.mockResolvedValue(null)
		const { channel, sent } = setup()
		await channel.onMessage(JSON.stringify({ type: 'vendor_error', code: 'x', message: 'y' }))
		expect(sent).toEqual([])
	})

	it('tags a tool-proxy exception with the session id', async () => {
		const { toolCall } = setup(vi.fn().mockRejectedValue(new Error('db down')))
		await toolCall('search_objects', { q: 'x' })
		expect(captureException).toHaveBeenCalledWith(SESSION_ID, expect.any(Error))
	})
})

describe('voice channel — a risky write waits for the person to say yes', () => {
	const WRITE_ARGS = { entity_id: ENTITY, content: 'hello' }

	function writeSetup() {
		const invoke = vi.fn().mockResolvedValue(textResult('done'))
		const ctx = setup(invoke)
		const results = () =>
			ctx.sent.filter((m) => m.type === 'tool_result') as Array<{
				ok: boolean
				error_code: string | null
				event: { item: { call_id: string; output: string } }
			}>
		const outputOf = (n: number) => JSON.parse(results()[n]?.event.item.output ?? '{}')
		const heldId = (n: number) => /confirmation_id "([^"]+)"/.exec(outputOf(n).error)?.[1] ?? ''
		const frame = (f: Record<string, unknown>) => ctx.channel.onMessage(JSON.stringify(f))
		/** The person starts speaking, and the transcript of that speech arrives. */
		const say = async (text: string, itemId: string) => {
			await frame({ type: 'user_speech_started', item_id: itemId })
			await frame({ type: 'transcript', role: 'user', text, item_id: itemId })
		}
		return { ...ctx, invoke, results, outputOf, heldId, frame, say }
	}

	afterEach(() => {
		vi.useRealTimers()
	})

	it('holds a write without running it and tells the model to ask', async () => {
		const { invoke, toolCall, results, outputOf } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[0]).toMatchObject({ ok: false, error_code: 'voice_confirmation_required' })
		expect(outputOf(0).error).toContain('Not done yet')
		expect(outputOf(0).error).toContain('confirmation_id')
	})

	it('runs the same call once after the person says yes, with the confirmation id removed', async () => {
		const { invoke, toolCall, results, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await say('Yeah, go ahead.', 'item_1')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_2')

		expect(invoke).toHaveBeenCalledTimes(1)
		expect(invoke.mock.calls[0]?.[0]).toBe('gmail_send_email')
		expect(invoke.mock.calls[0]?.[1]).toEqual({ ...WRITE_ARGS, workspace_id: WORKSPACE })
		expect(results()[1]).toMatchObject({ ok: true, error_code: null })

		// Single use: the same id again is a new hold.
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_3')
		expect(invoke).toHaveBeenCalledTimes(1)
		expect(results()[2]?.error_code).toBe('voice_confirmation_required')
	})

	it('runs the write when the yes is transcribed while the repeated call is waiting', async () => {
		vi.useFakeTimers()
		const { invoke, toolCall, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		const repeated = toolCall(
			'gmail_send_email',
			{ ...WRITE_ARGS, confirmation_id: heldId(0) },
			'call_2',
		)
		await vi.advanceTimersByTimeAsync(500)
		expect(invoke).not.toHaveBeenCalled()
		await say('yes', 'item_1')
		await repeated
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('refuses a repeated call when the model confirms but the person said nothing', async () => {
		vi.useFakeTimers()
		const { invoke, toolCall, results, heldId } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		const repeated = toolCall(
			'gmail_send_email',
			{ ...WRITE_ARGS, confirmation_id: heldId(0) },
			'call_2',
		)
		await vi.advanceTimersByTimeAsync(3_000)
		await repeated
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[1]).toMatchObject({ ok: false, error_code: 'voice_confirmation_missing' })
	})

	it('does not count speech that began before the hold as the answer', async () => {
		vi.useFakeTimers()
		const { invoke, toolCall, heldId, say, frame } = writeSetup()
		await frame({ type: 'user_speech_started', item_id: 'item_request' })
		await toolCall('gmail_send_email', WRITE_ARGS)
		// The request's own transcript lands after the hold. It is not an answer.
		await frame({ type: 'transcript', role: 'user', text: 'yes', item_id: 'item_request' })
		const repeated = toolCall(
			'gmail_send_email',
			{ ...WRITE_ARGS, confirmation_id: heldId(0) },
			'call_2',
		)
		await vi.advanceTimersByTimeAsync(3_000)
		await repeated
		expect(invoke).not.toHaveBeenCalled()

		// A later yes still works on the same hold.
		await say('yes', 'item_answer')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_3')
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('drops the action when the person says no', async () => {
		const { invoke, toolCall, results, outputOf, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await say('No, wait.', 'item_1')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_2')
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[1]?.error_code).toBe('voice_confirmation_missing')
		expect(outputOf(1).error).toContain('said no')
	})

	it.each([
		['a question', 'Yes, but which one?'],
		['a long answer', 'Yes please go ahead and do that right now'],
		['a hedge', 'Yes but wait'],
	])('does not take %s for a yes', async (_label, line) => {
		const { invoke, toolCall, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await say(line, 'item_1')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_2')
		expect(invoke).not.toHaveBeenCalled()
	})

	it('drops the action after 60 seconds, even if the person then says yes', async () => {
		vi.useFakeTimers()
		const { invoke, toolCall, results, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await vi.advanceTimersByTimeAsync(60_000)
		await say('yes', 'item_1')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_2')
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[1]?.error_code).toBe('voice_confirmation_required')
	})

	it('treats changed arguments as a new hold, not a confirmation', async () => {
		const { invoke, toolCall, results, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await say('yes', 'item_1')
		await toolCall(
			'gmail_send_email',
			{ ...WRITE_ARGS, content: 'something else', confirmation_id: heldId(0) },
			'call_2',
		)
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[1]?.error_code).toBe('voice_confirmation_required')
		expect(heldId(1)).not.toBe(heldId(0))
	})

	it('lets a newer write replace the pending one', async () => {
		const { invoke, toolCall, heldId, say } = writeSetup()
		await toolCall('gmail_send_email', WRITE_ARGS)
		await toolCall('delete_object', { id: ENTITY }, 'call_2')
		await say('yes', 'item_1')
		await toolCall('gmail_send_email', { ...WRITE_ARGS, confirmation_id: heldId(0) }, 'call_3')
		expect(invoke).not.toHaveBeenCalled()
	})

	it('holds a tool from an attached server and calls it risky', async () => {
		const { invoke, toolCall, results, outputOf } = writeSetup()
		await toolCall('gmail__send_email', { to: 'a@b.c' })
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[0]?.error_code).toBe('voice_confirmation_required')
		expect(outputOf(0).error).toContain('risky')
	})

	it('runs an ordinary workspace change at once, without a yes', async () => {
		const { invoke, toolCall, results } = writeSetup()
		await toolCall('create_comment', WRITE_ARGS)
		expect(invoke).toHaveBeenCalledTimes(1)
		expect(results()[0]).toMatchObject({ ok: true, error_code: null })
	})

	it('gives the model the real recipient, subject and text of a held send and posts the same in the chat', async () => {
		const { toolCall, outputOf, sent } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })

		const held = outputOf(0).error as string
		expect(held).toContain('To: Lars Honoré <lars@example.dk>')
		expect(held).toContain('Subject: Meeting')
		expect(held).toContain('Hello Lars, can we meet on Tuesday?')
		expect(buildHoldPreview.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { object_id: ENTITY, workspace_id: WORKSPACE },
		})
		expect(postHoldPreview).toHaveBeenCalledTimes(1)
		expect(postHoldPreview.mock.calls[0]?.[0].preview.body).toBe(
			'Hello Lars, can we meet on Tuesday?',
		)
		expect(sent).toContainEqual({ type: 'conversation', conversation_id: HOLD_CHAT })
	})

	it('tells the model to read a short text in full', async () => {
		const { toolCall, outputOf } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		expect(outputOf(0).error).toContain('the recipient, the subject and the whole text')
	})

	it('tells the model to read the edges of a long text and say the rest is in the chat', async () => {
		const long = `Opening line. ${'Filler sentence here. '.repeat(60)}Slot one is Tuesday. Slot two is Wednesday.`
		buildHoldPreview.mockResolvedValue(heldPreview('v1', long))
		const { toolCall, outputOf } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		const held = outputOf(0).error as string
		expect(held).toContain('Opening line.')
		expect(held).toContain('Slot two is Wednesday.')
		expect(held).toContain('full text is in the chat')
	})

	it('does not run on a yes for old text when the draft was edited after the hold', async () => {
		const { invoke, toolCall, results, heldId, outputOf, say } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		await say('Yes, send it.', 'item_1')
		// The same object id, other text behind it.
		buildHoldPreview.mockResolvedValue(heldPreview('v2', 'New wording: Thursday at 9.'))
		await toolCall('gmail_send_email', { object_id: ENTITY, confirmation_id: heldId(0) }, 'call_2')

		expect(invoke).not.toHaveBeenCalled()
		expect(results()[1]?.error_code).toBe('voice_confirmation_required')
		expect(heldId(1)).not.toBe(heldId(0))
		expect(outputOf(1).error).toContain('New wording: Thursday at 9.')
		expect(outputOf(1).error).toContain('earlier yes does not count')
		expect(postHoldPreview).toHaveBeenCalledTimes(2)
	})

	it('still holds and says plainly that it cannot read the text when no preview can be made', async () => {
		buildHoldPreview.mockRejectedValue(new Error('db down'))
		const { invoke, toolCall, results, outputOf } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		expect(invoke).not.toHaveBeenCalled()
		expect(results()[0]?.error_code).toBe('voice_confirmation_required')
		expect(outputOf(0).error).toContain('cannot read out the exact text')
		expect(postHoldPreview).not.toHaveBeenCalled()
	})

	it('tells the model to read the whole text when a long text could not be put in the chat', async () => {
		const long = `Opening line. ${'Filler sentence here. '.repeat(60)}Slot one is Tuesday. Slot two is Wednesday.`
		buildHoldPreview.mockResolvedValue(heldPreview('v1', long))
		postHoldPreview.mockRejectedValue(new Error('chat down'))
		const { toolCall, results, outputOf } = writeSetup()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		expect(results()[0]?.error_code).toBe('voice_confirmation_required')
		expect(outputOf(0).error).toContain('could not be put in the chat')
	})

	it('runs a read-only tool at once without a yes', async () => {
		const { invoke, toolCall } = writeSetup()
		await toolCall('get_objects', { ids: [ENTITY] })
		expect(invoke).toHaveBeenCalledTimes(1)
	})
})

describe('voice channel — show_in_chat', () => {
	const CONV = '8ec06d7f-ea92-4476-90b3-af5c2b46d997'

	it('posts into the call chat itself and never reaches the MCP server', async () => {
		showInChat.mockResolvedValue({ conversationId: CONV, messageId: 7 })
		const { toolCall, sent, invokeTool } = setup()
		await toolCall('show_in_chat', { object_ids: [ENTITY], workspace_id: OTHER_WORKSPACE })

		expect(invokeTool).not.toHaveBeenCalled()
		const args = showInChat.mock.calls[0]?.[0]
		expect(args.session).toBe(session)
		// The session decides where it writes; a workspace_id the model passes is not read.
		expect(args.session.workspaceId).toBe(WORKSPACE)
		expect(sent).toContainEqual({ type: 'conversation', conversation_id: CONV })
		const result = sent.find((m) => m.type === 'tool_result')
		expect(result).toMatchObject({ ok: true, error_code: null })
	})

	it('hands a refusal back to the model as a failed call', async () => {
		const { VoiceShowInChatError } = await import('../../services/voice-show-in-chat')
		showInChat.mockRejectedValue(new VoiceShowInChatError('Show at most 5 things.'))
		const { toolCall, sent } = setup()
		await toolCall('show_in_chat', { links: [] })
		const result = sent.find((m) => m.type === 'tool_result') as { ok: boolean; event: never }
		expect(result.ok).toBe(false)
		expect(JSON.stringify(result.event)).toContain('Show at most 5 things.')
	})
})

describe('voice channel — receipts', () => {
	const draft = {
		event: 'created_task',
		objectId: ENTITY,
		objectType: 'task',
		objectTitle: 'Reply to Anna',
		template: 'Created task {title}',
	}
	const receiptCalls = () => postReceiptLine.mock.calls.map((c) => c[0] as Record<string, unknown>)
	const sayItem = (channel: Channel, item: string, text: string) =>
		Promise.all([
			channel.onMessage(JSON.stringify({ type: 'user_speech_started', item_id: item })),
			channel.onMessage(JSON.stringify({ type: 'transcript', role: 'user', text, item_id: item })),
		])

	it('writes a line for a write that ran, before the model hears the result', async () => {
		describeToolCall.mockResolvedValue([draft])
		const order: string[] = []
		postReceiptLine.mockImplementation(async () => {
			order.push('line')
			return RECEIPT_CHAT
		})
		const invoke = vi.fn().mockResolvedValue(textResult('{"results":[{"id":"x"}]}'))
		const { sent, toolCall } = setup(invoke)
		const original = sent.push.bind(sent)
		sent.push = (...items) => {
			if ((items[0] as { type?: string }).type === 'tool_result') order.push('result')
			return original(...items)
		}
		await toolCall('create_objects', { objects: [{ type: 'task', title: 'Reply to Anna' }] })

		expect(order).toEqual(['line', 'result'])
		expect(receiptCalls()[0]).toMatchObject({
			tool: 'create_objects',
			outcome: 'ran',
			draft,
			agentName: 'Chief of Staff',
		})
		// The call was not pinned to a chat yet, so the browser is told which one the line landed in.
		expect(sent.filter((m) => m.type === 'conversation')).toEqual([
			{ type: 'conversation', conversation_id: RECEIPT_CHAT },
		])
		expect(JSON.parse(lastResult(sent).event.item.output)).toEqual({ results: [{ id: 'x' }] })
	})

	it('writes a failed line with the reason when a tool returns an error', async () => {
		describeToolCall.mockResolvedValue([draft])
		const invoke = vi.fn().mockResolvedValue({
			isError: true,
			content: [{ type: 'text', text: 'status is not allowed' }],
		})
		const { toolCall } = setup(invoke)
		await toolCall('update_objects', { updates: [{ id: ENTITY, status: 'nope' }] })
		expect(receiptCalls()[0]).toMatchObject({ outcome: 'failed', reason: 'status is not allowed' })
	})

	it('writes a failed line when the tool throws, and still answers the model', async () => {
		describeToolCall.mockResolvedValue([draft])
		const invoke = vi.fn().mockRejectedValue(new Error('API 500: boom'))
		const { sent, toolCall } = setup(invoke)
		await toolCall('update_objects', { updates: [{ id: ENTITY }] })
		expect(receiptCalls()[0]).toMatchObject({ outcome: 'failed', reason: 'API 500: boom' })
		expect(lastResult(sent)).toMatchObject({ ok: false })
	})

	it('leaves no line for a read, for show_in_chat or for a held write', async () => {
		describeToolCall.mockResolvedValue([draft])
		showInChat.mockResolvedValue({ conversationId: HOLD_CHAT, messageId: 1 })
		const { toolCall } = setup(vi.fn().mockResolvedValue(textResult('ok')))
		await toolCall('search_objects', { q: 'x' })
		await toolCall('show_in_chat', { object_ids: [ENTITY] }, 'call_2')
		await toolCall('gmail_send_email', { object_id: ENTITY }, 'call_3')
		expect(postReceiptLine).not.toHaveBeenCalled()
	})

	it('writes an opened-task line for get_objects, but only when it describes one', async () => {
		describeToolCall.mockResolvedValue([
			{ ...draft, event: 'opened_task', template: 'Opened task {title}' },
		])
		const { toolCall } = setup(vi.fn().mockResolvedValue(textResult('{}')))
		await toolCall('get_objects', { ids: [ENTITY] })
		expect(receiptCalls()[0]).toMatchObject({ outcome: 'ran', tool: 'get_objects' })
		postReceiptLine.mockClear()
		describeToolCall.mockResolvedValue([])
		await toolCall('get_objects', { ids: [ENTITY] }, 'call_2')
		expect(postReceiptLine).not.toHaveBeenCalled()
	})

	it('records a send that went through a yes with its yes count and read-back', async () => {
		describeToolCall.mockResolvedValue([
			{ ...draft, event: 'other', template: 'Ran gmail send email on {title}' },
		])
		const invoke = vi.fn().mockResolvedValue(textResult('sent'))
		const { channel, sent, toolCall } = setup(invoke)
		await toolCall('gmail_send_email', { object_id: ENTITY })
		const hold = JSON.parse(lastResult(sent).event.item.output).error as string
		const id = /confirmation_id "([^"]+)"/.exec(hold)?.[1]
		expect(postReceiptLine).not.toHaveBeenCalled()
		await sayItem(channel, 'item_yes', 'yes')
		await toolCall('gmail_send_email', { object_id: ENTITY, confirmation_id: id }, 'call_2')
		expect(receiptCalls()[0]).toMatchObject({
			outcome: 'ran',
			send: { yesCount: 1, readBackMatches: true },
		})
	})

	it('records a hold the person turned down as not done', async () => {
		const { channel, toolCall } = setup(vi.fn())
		await toolCall('gmail_send_email', { object_id: ENTITY })
		await sayItem(channel, 'item_no', 'no, wait')
		await vi.waitFor(() => expect(postReceiptLine).toHaveBeenCalledTimes(1))
		expect(receiptCalls()[0]).toMatchObject({
			tool: 'gmail_send_email',
			outcome: 'not_done',
			reason: 'You said no.',
		})
		expect(receiptCalls()[0]?.draft).toMatchObject({ template: 'Send this email' })
	})

	it('does not record the same send asked again as not done', async () => {
		const { toolCall } = setup(vi.fn())
		await toolCall('gmail_send_email', { object_id: ENTITY })
		await toolCall('gmail_send_email', { object_id: ENTITY, note: 'again' }, 'call_2')
		expect(postReceiptLine).not.toHaveBeenCalled()
	})

	it('records a hold replaced by a different request as not done', async () => {
		const { toolCall } = setup(vi.fn())
		await toolCall('gmail_send_email', { object_id: ENTITY })
		await toolCall('create_notification', { title: 'hi' }, 'call_2')
		await vi.waitFor(() => expect(postReceiptLine).toHaveBeenCalledTimes(1))
		expect(receiptCalls()[0]).toMatchObject({
			outcome: 'not_done',
			reason: 'It was replaced by a newer request.',
		})
	})

	it('keeps the pending hold where the closing receipt can read it, with no draft text', async () => {
		const { toolCall } = setup(vi.fn())
		expect(peekVoiceCallState(SESSION_ID)?.pendingHold?.()).toBeNull()
		await toolCall('gmail_send_email', { object_id: ENTITY })
		expect(peekVoiceCallState(SESSION_ID)?.pendingHold?.()).toEqual({
			tool: 'gmail_send_email',
			summary: 'Send this email',
			yesCount: 0,
		})
	})

	it('still answers the model when the line cannot be written', async () => {
		describeToolCall.mockResolvedValue([draft])
		postReceiptLine.mockRejectedValue(new Error('db down'))
		const { sent, toolCall } = setup(vi.fn().mockResolvedValue(textResult('done')))
		await toolCall('create_objects', { objects: [] })
		expect(lastResult(sent)).toMatchObject({ ok: true })
	})

	it('marks a card cleared, sends the card action with source voice, and names the first card', async () => {
		const state = voiceCallState(SESSION_ID)
		state.startCards = [
			{
				objectId: '7dbf5c6e-df81-4365-8fa2-9e4b1f35c886',
				notificationId: null,
				source: 'curated',
				rank: 1,
			},
			{ objectId: ENTITY, notificationId: null, source: 'decision', rank: 2 },
		]
		describeToolCall.mockResolvedValue([draft])
		const { toolCall } = setup(vi.fn().mockResolvedValue(textResult('ok')))
		await toolCall('create_comment', { entity_id: ENTITY, content: 'ok' })
		expect(receiptCalls()[0]).toMatchObject({ cardId: ENTITY })
		expect(captureCardAction).toHaveBeenCalledWith(HUMAN, {
			voice_session_id: SESSION_ID,
			workspace_id: WORKSPACE,
			card_id: ENTITY,
			card_kind: 'decision',
			action_id: 'create_comment',
		})
		expect(state.firstCardNamed).toBe(ENTITY)
	})

	it('does not count a read, a failure or a non-card object as a cleared card', async () => {
		const state = voiceCallState(SESSION_ID)
		state.startCards = [{ objectId: ENTITY, notificationId: null, source: 'curated', rank: 1 }]
		describeToolCall.mockResolvedValue([draft])
		const failing = vi
			.fn()
			.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'no' }] })
		const { toolCall } = setup(failing)
		await toolCall('update_objects', { updates: [{ id: ENTITY }] })
		expect(receiptCalls()[0]?.cardId ?? null).toBeNull()
		expect(captureCardAction).not.toHaveBeenCalled()
	})

	it('notes the first card shown with show_in_chat', async () => {
		const state = voiceCallState(SESSION_ID)
		state.startCards = [{ objectId: ENTITY, notificationId: null, source: 'curated', rank: 1 }]
		showInChat.mockResolvedValue({ conversationId: HOLD_CHAT, messageId: 1 })
		const { toolCall } = setup(vi.fn())
		await toolCall('show_in_chat', { object_ids: [ENTITY] })
		expect(state.firstCardNamed).toBe(ENTITY)
	})
})
