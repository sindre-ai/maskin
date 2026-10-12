import { describe, expect, it } from 'vitest'
import { LlmNoEligibleHostError } from '../../lib/llm/adapter'
import {
	type ChatStreamEvent,
	LlmStreamError,
	ToolCallAccumulator,
	streamChatCompletion,
} from '../../lib/llm/openai-stream'
import { type SseEvent, parseSseStream } from '../../lib/sse-parser'

const enc = new TextEncoder()

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
	let i = 0
	return new ReadableStream({
		pull(controller) {
			if (i >= chunks.length) return controller.close()
			const c = chunks[i++]
			controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
		},
	})
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const out: T[] = []
	for await (const v of gen) out.push(v)
	return out
}

describe('parseSseStream', () => {
	it('parses events split across chunk boundaries', async () => {
		const events = await collect(
			parseSseStream(streamOf(['da', 'ta: {"a":', '1}\n\ndata: two\n\n'])),
		)
		expect(events).toEqual<SseEvent[]>([{ data: '{"a":1}' }, { data: 'two' }])
	})

	it('handles CRLF, including a CR and LF split across chunks', async () => {
		const events = await collect(parseSseStream(streamOf(['data: a\r', '\n\r\ndata: b\r\n\r\n'])))
		expect(events.map((e) => e.data)).toEqual(['a', 'b'])
	})

	it('joins multi-line data and keeps the event name', async () => {
		const events = await collect(parseSseStream(streamOf(['event: x\ndata: one\ndata: two\n\n'])))
		expect(events).toEqual([{ event: 'x', data: 'one\ntwo' }])
	})

	it('ignores comment keepalives', async () => {
		const events = await collect(
			parseSseStream(streamOf([': OPENROUTER PROCESSING\n\n', 'data: hi\n\n'])),
		)
		expect(events).toEqual([{ data: 'hi' }])
	})

	it('decodes a multi-byte character split across chunks', async () => {
		const bytes = enc.encode('data: å\n\n')
		const events = await collect(parseSseStream(streamOf([bytes.slice(0, 7), bytes.slice(7)])))
		expect(events[0].data).toBe('å')
	})

	it('flushes a final event with no trailing blank line', async () => {
		const events = await collect(parseSseStream(streamOf(['data: tail'])))
		expect(events).toEqual([{ data: 'tail' }])
	})

	it('stops reading when aborted', async () => {
		const ac = new AbortController()
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(enc.encode('data: x\n\n'))
			},
		})
		const seen: string[] = []
		for await (const ev of parseSseStream(body, ac.signal)) {
			seen.push(ev.data)
			ac.abort()
		}
		expect(seen.length).toBeGreaterThanOrEqual(1)
		expect(seen.length).toBeLessThan(5)
	})
})

function sse(...chunks: unknown[]): string {
	return `${chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')}`
}

function fakeFetch(body: string, init: { status?: number } = {}): typeof fetch {
	return (async () =>
		new Response(streamOf([body]), {
			status: init.status ?? 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})) as unknown as typeof fetch
}

const base = { apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b', messages: [] }

describe('streamChatCompletion', () => {
	it('streams text deltas, finish reason and usage with cost', async () => {
		const body = sse(
			{ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
			{ choices: [{ delta: { content: 'lo.' } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
			{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 } },
			'[DONE]',
		)
		const events = await collect(streamChatCompletion({ ...base, fetchImpl: fakeFetch(body) }))
		expect(events).toEqual<ChatStreamEvent[]>([
			{ type: 'text', delta: 'Hel' },
			{ type: 'text', delta: 'lo.' },
			{ type: 'finish', reason: 'stop' },
			{ type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 } },
		])
	})

	it('reassembles two interleaved tool calls by index', async () => {
		const body = sse(
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: 'c0', function: { name: 'search_objects', arguments: '{"q":' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 1, id: 'c1', function: { name: 'list_actors', arguments: '' } },
							],
						},
					},
				],
			},
			{
				choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"retries"}' } }] } }],
			},
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] },
						finish_reason: 'tool_calls',
					},
				],
			},
			'[DONE]',
		)
		const acc = new ToolCallAccumulator()
		let reason: string | undefined
		for await (const ev of streamChatCompletion({ ...base, fetchImpl: fakeFetch(body) })) {
			if (ev.type === 'tool_call') acc.push(ev)
			if (ev.type === 'finish') reason = ev.reason
		}
		expect(reason).toBe('tool_calls')
		expect(acc.finish()).toEqual([
			{ id: 'c0', name: 'search_objects', arguments: { q: 'retries' } },
			{ id: 'c1', name: 'list_actors', arguments: {} },
		])
	})

	it('reports unparseable tool arguments instead of throwing', () => {
		const acc = new ToolCallAccumulator()
		acc.push({ type: 'tool_call', index: 0, id: 'c', name: 'x', argumentsDelta: '{"q":' })
		const [call] = acc.finish()
		expect(call.parseError).toBeTruthy()
		expect(call.arguments).toEqual({})
	})

	it('skips malformed chunks and emits a closing finish when the stream ends without one', async () => {
		const body = sse('not json', { choices: [{ delta: { content: 'ok' } }] })
		const events = await collect(streamChatCompletion({ ...base, fetchImpl: fakeFetch(body) }))
		expect(events).toEqual([
			{ type: 'text', delta: 'ok' },
			{ type: 'finish', reason: 'other' },
		])
	})

	it('raises a mid-stream provider error', async () => {
		const body = sse({ error: { code: 502, message: 'upstream died' } })
		await expect(
			collect(streamChatCompletion({ ...base, fetchImpl: fakeFetch(body) })),
		).rejects.toThrow(/upstream died/)
	})

	it('raises LlmStreamError with the status on an HTTP failure', async () => {
		const f = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
		await expect(collect(streamChatCompletion({ ...base, fetchImpl: f }))).rejects.toMatchObject({
			name: 'LlmStreamError',
			status: 401,
		})
	})

	it('maps a provider-preference miss to LlmNoEligibleHostError only when preferences were sent', async () => {
		const f = (async () =>
			new Response('No endpoints found for x', { status: 404 })) as unknown as typeof fetch
		await expect(
			collect(
				streamChatCompletion({ ...base, extraBody: { provider: { zdr: true } }, fetchImpl: f }),
			),
		).rejects.toBeInstanceOf(LlmNoEligibleHostError)
		await expect(collect(streamChatCompletion({ ...base, fetchImpl: f }))).rejects.toBeInstanceOf(
			LlmStreamError,
		)
	})

	it('sends stream, usage include, tools and extra body', async () => {
		let sent: Record<string, unknown> = {}
		const f = (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(init.body as string)
			return new Response(streamOf(['data: [DONE]\n\n']), { status: 200 })
		}) as unknown as typeof fetch
		await collect(
			streamChatCompletion({
				...base,
				extraBody: { provider: { zdr: true } },
				tools: [
					{
						type: 'function',
						function: { name: 't', description: 'd', parameters: { type: 'object' } },
					},
				],
				fetchImpl: f,
			}),
		)
		expect(sent.stream).toBe(true)
		expect(sent.usage).toEqual({ include: true })
		expect(sent.provider).toEqual({ zdr: true })
		expect(Array.isArray(sent.tools)).toBe(true)
	})
})
