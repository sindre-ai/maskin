import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type DelegateModel,
	VOICE_DELEGATE_ANSWER_CHARS,
	VOICE_DELEGATE_DEFAULT_MODEL,
	openAiDelegateModel,
	redactSecrets,
	resolveVoiceDelegateModel,
	resolveVoiceToolMode,
	runVoiceDelegate,
	voiceAskWorkspaceTool,
} from '../../services/voice-delegate'

const tools = ['search_objects', 'update_objects'].map((name) => ({
	type: 'function' as const,
	name,
	description: name,
	parameters: { type: 'object', properties: {} },
}))

type Turn = Awaited<ReturnType<DelegateModel['complete']>>
const call = (name: string, id = 'c1'): Turn => ({
	text: null,
	toolCalls: [{ id, name, arguments: { q: 'x' } }],
})
const scripted = (turns: Turn[]): DelegateModel => ({
	complete: vi.fn(async () => turns.shift() ?? { text: 'fallback', toolCalls: [] }),
})
const result = (text = 'ok') => ({ kind: 'result' as const, text, isError: false })

afterEach(() => {
	vi.useRealTimers()
})

describe('runVoiceDelegate', () => {
	it('runs the tools the model asks for and returns its final answer', async () => {
		const callTool = vi.fn(async () => result('3 rows'))
		const out = await runVoiceDelegate({
			request: 'find x',
			tools,
			model: scripted([call('search_objects'), { text: 'Found three.', toolCalls: [] }]),
			callTool,
		})
		expect(out).toEqual({ kind: 'answer', text: 'Found three.' })
		expect(callTool).toHaveBeenCalledWith('search_objects', { q: 'x' })
	})

	it('feeds the tool result back to the model', async () => {
		const model = scripted([call('search_objects'), { text: 'done', toolCalls: [] }])
		await runVoiceDelegate({ request: 'r', tools, model, callTool: async () => result('ROWS') })
		const second = vi.mocked(model.complete).mock.calls[1]?.[0].messages ?? []
		expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'ROWS' })
		expect(second.at(-2)).toMatchObject({ role: 'assistant' })
	})

	it('stops at the first held tool and returns the hold for the voice model', async () => {
		const model = scripted([
			{
				text: null,
				toolCalls: [
					{ id: 'a', name: 'update_objects', arguments: {} },
					{ id: 'b', name: 'search_objects', arguments: {} },
				],
			},
		])
		const callTool = vi
			.fn()
			.mockResolvedValueOnce({ kind: 'held', output: '{"error":"Not done yet"}', errorCode: 'h' })
		const out = await runVoiceDelegate({ request: 'r', tools, model, callTool })
		expect(out).toEqual({ kind: 'held', output: '{"error":"Not done yet"}', errorCode: 'h' })
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(model.complete).toHaveBeenCalledTimes(1)
	})

	it('gives up after the step cap and says what was done', async () => {
		const model: DelegateModel = { complete: vi.fn(async () => call('search_objects')) }
		const out = await runVoiceDelegate({
			request: 'r',
			tools,
			model,
			callTool: async () => result(),
			maxSteps: 3,
		})
		expect(model.complete).toHaveBeenCalledTimes(3)
		expect(out).toMatchObject({ kind: 'incomplete', reason: 'steps' })
		expect((out as { text: string }).text).toContain('search objects')
	})

	it('gives up when the time budget runs out, even if a tool hangs', async () => {
		vi.useFakeTimers()
		const pending = runVoiceDelegate({
			request: 'r',
			tools,
			model: scripted([call('search_objects')]),
			callTool: () => new Promise(() => {}),
			budgetMs: 1_000,
		})
		await vi.advanceTimersByTimeAsync(1_001)
		expect(await pending).toMatchObject({ kind: 'incomplete', reason: 'time' })
	})

	it('stops when the call ends', async () => {
		const ended = new AbortController()
		const model: DelegateModel = {
			complete: vi.fn(({ signal }) => {
				return new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(new Error('x'))),
				)
			}),
		}
		const pending = runVoiceDelegate({
			request: 'r',
			tools,
			model,
			callTool: async () => result(),
			signal: ended.signal,
		})
		ended.abort()
		expect(await pending).toMatchObject({ kind: 'incomplete', reason: 'aborted' })
	})

	it('does not start when the call has already ended', async () => {
		const ended = new AbortController()
		ended.abort()
		const model = scripted([])
		const out = await runVoiceDelegate({
			request: 'r',
			tools,
			model,
			callTool: async () => result(),
			signal: ended.signal,
		})
		expect(out).toMatchObject({ kind: 'incomplete', reason: 'aborted' })
		expect(model.complete).not.toHaveBeenCalled()
	})

	it('refuses a tool that is not in its list without running anything', async () => {
		const callTool = vi.fn()
		const model = scripted([call('gmail_send_email'), { text: 'could not', toolCalls: [] }])
		const out = await runVoiceDelegate({ request: 'r', tools, model, callTool })
		expect(callTool).not.toHaveBeenCalled()
		expect(out).toEqual({ kind: 'answer', text: 'could not' })
	})

	it('caps what a tool result adds to the model context and the answer it returns', async () => {
		const model = scripted([call('search_objects'), { text: 'x'.repeat(10_000), toolCalls: [] }])
		const out = await runVoiceDelegate({
			request: 'r',
			tools,
			model,
			callTool: async () => result('y'.repeat(200_000)),
		})
		const toolMessage = vi.mocked(model.complete).mock.calls[1]?.[0].messages.at(-1)
		expect((toolMessage as { content: string }).content.length).toBeLessThan(20_000)
		expect((out as { text: string }).text.length).toBeLessThanOrEqual(
			VOICE_DELEGATE_ANSWER_CHARS + 400,
		)
	})

	it('keeps keys and tokens out of the answer', async () => {
		const model = scripted([{ text: 'Your key is ank_abcdef1234567890 ok', toolCalls: [] }])
		const out = await runVoiceDelegate({
			request: 'r',
			tools,
			model,
			callTool: async () => result(),
		})
		expect((out as { text: string }).text).not.toContain('ank_abcdef')
		expect(redactSecrets('Bearer abcdefghijklmnop1234')).toBe('[redacted]')
	})

	it('reports an error from the model as incomplete rather than throwing', async () => {
		const model: DelegateModel = {
			complete: async () => {
				throw new Error('500')
			},
		}
		expect(
			await runVoiceDelegate({ request: 'r', tools, model, callTool: async () => result() }),
		).toMatchObject({
			kind: 'incomplete',
			reason: 'error',
		})
	})
})

describe('openAiDelegateModel', () => {
	it('sends tool calls back in the shape OpenAI wants and parses the reply', async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: null,
									tool_calls: [
										{ id: 'k1', function: { name: 'search_objects', arguments: '{"q":"a"}' } },
									],
								},
							},
						],
					}),
				),
		)
		const model = openAiDelegateModel({ apiKey: 'k', model: 'm', fetchFn: fetchFn as never })
		const turn = await model.complete({
			messages: [
				{ role: 'user', content: 'hi' },
				{
					role: 'assistant',
					content: null,
					tool_calls: [{ id: 'p', name: 'x', arguments: { a: 1 } }],
				},
				{ role: 'tool', tool_call_id: 'p', content: 'r' },
			],
			tools,
			signal: new AbortController().signal,
		})
		expect(turn.toolCalls).toEqual([{ id: 'k1', name: 'search_objects', arguments: { q: 'a' } }])
		const body = JSON.parse(
			(fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
		)
		expect(body.model).toBe('m')
		expect(body.messages[1].tool_calls[0]).toEqual({
			id: 'p',
			type: 'function',
			function: { name: 'x', arguments: '{"a":1}' },
		})
	})

	it('throws on a non-200 so the loop ends', async () => {
		const model = openAiDelegateModel({
			apiKey: 'k',
			model: 'm',
			fetchFn: (async () => new Response('no', { status: 429 })) as never,
		})
		await expect(
			model.complete({ messages: [], tools, signal: new AbortController().signal }),
		).rejects.toThrow('429')
	})
})

describe('settings', () => {
	it('defaults the tool mode to core and only full switches it back', () => {
		expect(resolveVoiceToolMode({})).toBe('core')
		expect(resolveVoiceToolMode({ MASKIN_VOICE_TOOL_MODE: 'bogus' })).toBe('core')
		expect(resolveVoiceToolMode({ MASKIN_VOICE_TOOL_MODE: ' FULL ' })).toBe('full')
	})

	it('reads the delegate model from the environment', () => {
		expect(resolveVoiceDelegateModel({})).toBe(VOICE_DELEGATE_DEFAULT_MODEL)
		expect(resolveVoiceDelegateModel({ MASKIN_VOICE_DELEGATE_MODEL: 'gpt-x' })).toBe('gpt-x')
	})

	it('describes ask_workspace with a required request and an optional confirmation id', () => {
		expect(voiceAskWorkspaceTool.name).toBe('ask_workspace')
		expect(voiceAskWorkspaceTool.parameters.required).toEqual(['request'])
		expect(Object.keys(voiceAskWorkspaceTool.parameters.properties)).toEqual([
			'request',
			'confirmation_id',
		])
	})
})
