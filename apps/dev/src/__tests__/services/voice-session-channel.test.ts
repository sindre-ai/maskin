import type { Database } from '@maskin/db'
import { UnknownToolError } from '@maskin/mcp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureToolCall = vi.fn()
const captureTurnCompleted = vi.fn()
vi.mock('../../lib/analytics/voice-events', () => ({
	captureVoiceToolCall: (...args: unknown[]) => captureToolCall(...args),
	captureVoiceTurnCompleted: (...args: unknown[]) => captureTurnCompleted(...args),
}))

const writeLine = vi.fn()
const persistenceEnabled = vi.fn()
vi.mock('../../services/voice-transcript', () => ({
	writeVoiceTranscriptLine: (...args: unknown[]) => writeLine(...args),
	isTranscriptPersistenceEnabled: (...args: unknown[]) => persistenceEnabled(...args),
}))

const { createVoiceChannel } = await import('../../services/voice-session-channel')
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

function setup(invokeTool = vi.fn()) {
	const sent: Array<Record<string, unknown>> = []
	const channel: Channel = createVoiceChannel({
		db: {} as Database,
		session,
		agentName: 'Chief of Staff',
		invokeTool,
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
	writeLine.mockReset()
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
	it('runs a whitelisted read through invokeTool as the agent and returns a function_call_output', async () => {
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

	it('pins workspace_id to the session workspace even when the model passes another', async () => {
		const invoke = vi.fn().mockResolvedValue(textResult('ok'))
		const { toolCall } = setup(invoke)
		await toolCall('search_objects', { q: 'x', workspace_id: OTHER_WORKSPACE })
		expect(invoke.mock.calls[0]?.[1]).toMatchObject({ workspace_id: WORKSPACE })
	})

	it('refuses create_comment at attention 4 and 5 without calling the tool', async () => {
		for (const attention of [4, 5]) {
			const invoke = vi.fn()
			const { sent, toolCall } = setup(invoke)
			await toolCall('create_comment', { entity_id: ENTITY, content: 'hi', attention })
			expect(invoke).not.toHaveBeenCalled()
			const result = lastResult(sent)
			expect(result).toMatchObject({ ok: false, error_code: 'voice_attention_too_high' })
			expect(JSON.parse(result.event.item.output)).toMatchObject({
				error_code: 'voice_attention_too_high',
			})
		}
	})

	it('lets create_comment through at attention 3', async () => {
		const invoke = vi.fn().mockResolvedValue(textResult('{"id":1}'))
		const { sent, toolCall } = setup(invoke)
		await toolCall('create_comment', { entity_id: ENTITY, content: 'hi', attention: 3 })
		expect(invoke).toHaveBeenCalledTimes(1)
		expect(lastResult(sent).ok).toBe(true)
	})

	it('refuses create_objects of a non-insight/task type, accepts insight and task', async () => {
		const node = (type: string) => ({
			nodes: [{ $id: 'n', type, title: 'x', status: type === 'task' ? 'backlog' : 'new' }],
		})
		const refused = setup(vi.fn())
		await refused.toolCall('create_objects', node('bet'))
		expect(refused.invokeTool).not.toHaveBeenCalled()
		expect(lastResult(refused.sent).error_code).toBe('voice_create_objects_type_not_allowed')

		for (const type of ['insight', 'task']) {
			const invoke = vi.fn().mockResolvedValue(textResult('{}'))
			const { sent, toolCall } = setup(invoke)
			await toolCall('create_objects', node(type))
			expect(invoke).toHaveBeenCalledTimes(1)
			expect(lastResult(sent).ok).toBe(true)
		}
	})

	it('refuses a tool off the whitelist', async () => {
		const invoke = vi.fn()
		const { sent, toolCall } = setup(invoke)
		await toolCall('delete_object', { id: ENTITY })
		expect(invoke).not.toHaveBeenCalled()
		expect(lastResult(sent).error_code).toBe('voice_tool_not_allowed')
	})

	it('answers unparseable arguments with voice_invalid_arguments', async () => {
		const invoke = vi.fn()
		const { sent, toolCall } = setup(invoke)
		await toolCall('search_objects', '{not json')
		expect(invoke).not.toHaveBeenCalled()
		expect(lastResult(sent).error_code).toBe('voice_invalid_arguments')
	})

	it('reports a tool that returns isError as a failed call', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'bad status' }] })
		const { sent, toolCall } = setup(invoke)
		await toolCall('create_objects', {
			nodes: [{ $id: 'n', type: 'task', title: 'x', status: 'nope' }],
		})
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

	it('maps an unknown-tool throw to not-allowed', async () => {
		const invoke = vi.fn().mockRejectedValue(new UnknownToolError('search_objects'))
		const { sent, toolCall } = setup(invoke)
		await toolCall('search_objects', { q: 'x' })
		expect(lastResult(sent).error_code).toBe('voice_tool_not_allowed')
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
		const invoke = vi.fn().mockResolvedValue(textResult('ok'))
		const { toolCall } = setup(invoke)
		await toolCall('search_objects', { q: 'x' })
		await toolCall('create_comment', { entity_id: ENTITY, content: 'hi', attention: 5 }, 'call_2')

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
			tool_name: 'create_comment',
			success: false,
			latency_ms: expect.any(Number),
			error_code: 'voice_attention_too_high',
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
