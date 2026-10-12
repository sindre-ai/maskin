import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../lib/llm/openai-stream'
import {
	type LiveTurnDeps,
	type LiveTurnSinks,
	type PendingConfirmation,
	runLiveTurn,
} from '../../services/live-turn-runner'

type Script = ChatStreamEvent[]

const text = (delta: string): ChatStreamEvent => ({ type: 'text', delta })
const finish = (reason: 'stop' | 'tool_calls' | 'length' = 'stop'): ChatStreamEvent => ({
	type: 'finish',
	reason,
})
const call = (index: number, id: string, name: string, args: string): ChatStreamEvent => ({
	type: 'tool_call',
	index,
	id,
	name,
	argumentsDelta: args,
})

function makeSinks() {
	const log: string[] = []
	const sinks: LiveTurnSinks = {
		onDelta: (t) => log.push(`delta:${t}`),
		onRetract: () => log.push('retract'),
		onToolStarted: (_id, label) => log.push(`start:${label}`),
		onToolFinished: (_id, label, ok) => log.push(`done:${label}:${ok}`),
		onConfirmRequired: (p) => log.push(`confirm:${p.name}`),
	}
	return { sinks, log }
}

function makeDeps(scripts: Script[], over: Partial<LiveTurnDeps> = {}) {
	const requests: Array<{ messages: unknown[]; tools?: unknown[] }> = []
	let i = 0
	const deps: LiveTurnDeps = {
		stream: async function* (params) {
			requests.push({ messages: structuredClone(params.messages), tools: params.tools })
			const script = scripts[Math.min(i++, scripts.length - 1)] ?? []
			for (const ev of script) {
				if (params.signal.aborted) throw new DOMException('Aborted', 'AbortError')
				yield ev
			}
		},
		invokeTool: vi.fn(async (name: string) => ({ ok: true, name })),
		parseArgs: (_n, raw) => (raw ?? {}) as Record<string, unknown>,
		riskOf: (name) => (name.startsWith('delete') ? 'confirm' : 'read'),
		label: (n) => `Doing ${n}`,
		summarize: (n) => `Run ${n}`,
		tools: [],
		...over,
	}
	return { deps, requests }
}

const base = {
	system: 'sys',
	history: [],
	userText: 'hi',
	pendingConfirmation: null,
	pseudoCorrectionSpent: false,
}

describe('runLiveTurn', () => {
	it('streams a plain answer and sums usage', async () => {
		const { deps } = makeDeps([
			[
				text('Hello '),
				text('there.'),
				finish(),
				{ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.001 } },
			],
		])
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(r.text).toBe('Hello there.')
		expect(r.finish).toBe('stop')
		expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 4, costUsd: 0.001 })
		expect(log).toEqual(['delta:Hello ', 'delta:there.'])
	})

	it('runs a tool, feeds the result back, then speaks the answer', async () => {
		const { deps, requests } = makeDeps([
			[call(0, 'c1', 'search_objects', '{"q":"retries"}'), finish('tool_calls')],
			[text('Found it.'), finish()],
		])
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(deps.invokeTool).toHaveBeenCalledWith('search_objects', { q: 'retries' })
		expect(r.text).toBe('Found it.')
		expect(r.toolCalls).toHaveLength(1)
		expect(log).toEqual([
			'start:Doing search_objects',
			'done:Doing search_objects:true',
			'delta:Found it.',
		])
		const second = requests[1]?.messages as Array<{ role: string }>
		expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
	})

	it('runs parallel calls and answers each by its own id', async () => {
		const { deps, requests } = makeDeps([
			[call(0, 'a', 'list_actors', '{}'), call(1, 'b', 'list_objects', '{}'), finish('tool_calls')],
			[text('Done.'), finish()],
		])
		const { sinks } = makeSinks()
		await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		const tools = (requests[1]?.messages as Array<{ role: string; tool_call_id?: string }>).filter(
			(m) => m.role === 'tool',
		)
		expect(tools.map((m) => m.tool_call_id)).toEqual(['a', 'b'])
	})

	it('holds a confirm-tier call instead of running it', async () => {
		const { deps } = makeDeps([
			[call(0, 'c1', 'delete_object', '{"id":"x"}'), finish('tool_calls')],
			[text('Should I delete it?'), finish()],
		])
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(deps.invokeTool).not.toHaveBeenCalled()
		expect(r.pendingConfirmation?.name).toBe('delete_object')
		expect(r.pendingConfirmation?.summary).toBe('Run delete_object')
		expect(log).toContain('confirm:delete_object')
	})

	it('runs a confirmed action through the local confirm tool with the stored arguments', async () => {
		const pending: PendingConfirmation = {
			id: 'p1',
			name: 'delete_object',
			args: { id: 'stored' },
			label: 'x',
			summary: 'Delete it',
			expiresAt: Date.now() + 60_000,
		}
		const run = vi.fn(async () => ({ deleted: true }))
		const { deps } = makeDeps(
			[
				[call(0, 'c', 'confirm_pending_action', '{"approved":true}'), finish('tool_calls')],
				[text('Deleted.'), finish()],
			],
			{
				localTools: {
					confirm_pending_action: {
						definition: {
							type: 'function',
							function: { name: 'confirm_pending_action', description: '', parameters: {} },
						},
						label: 'Checking your answer',
						run,
					},
				},
			},
		)
		const { sinks } = makeSinks()
		const r = await runLiveTurn({
			...base,
			deps,
			sinks,
			pendingConfirmation: pending,
			signal: new AbortController().signal,
		})
		expect(run).toHaveBeenCalledOnce()
		expect(r.text).toBe('Deleted.')
	})

	it('drops an expired pending confirmation', async () => {
		const expired: PendingConfirmation = {
			id: 'p',
			name: 'n',
			args: {},
			label: '',
			summary: '',
			expiresAt: Date.now() - 1,
		}
		const { deps } = makeDeps([[text('ok'), finish()]])
		const { sinks } = makeSinks()
		const r = await runLiveTurn({
			...base,
			deps,
			sinks,
			pendingConfirmation: expired,
			signal: new AbortController().signal,
		})
		expect(r.pendingConfirmation).toBeNull()
	})

	it('returns a readable error to the model for bad arguments and keeps going', async () => {
		const { deps, requests } = makeDeps([
			[call(0, 'c1', 'get_objects', '{"ids":'), finish('tool_calls')],
			[text('Sorry, retrying.'), finish()],
		])
		const { sinks } = makeSinks()
		await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(deps.invokeTool).not.toHaveBeenCalled()
		const toolMsg = (requests[1]?.messages as Array<{ role: string; content: string }>).find(
			(m) => m.role === 'tool',
		)
		expect(toolMsg?.content).toContain('invalid_arguments')
	})

	it('reports a failing tool as an error result, not an exception', async () => {
		const { deps } = makeDeps(
			[
				[call(0, 'c1', 'search_objects', '{}'), finish('tool_calls')],
				[text('That failed.'), finish()],
			],
			{
				invokeTool: vi.fn(async () => {
					throw new Error('boom')
				}),
			},
		)
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(r.toolCalls[0]?.ok).toBe(false)
		expect(log).toContain('done:Doing search_objects:false')
	})

	it('withholds tools on the last round so the model must answer', async () => {
		const loop: Script = [call(0, 'c', 'list_actors', '{}'), finish('tool_calls')]
		const { deps, requests } = makeDeps([loop, loop, [text('Enough.'), finish()]], {
			maxRounds: 3,
			tools: [
				{ type: 'function', function: { name: 'list_actors', description: '', parameters: {} } },
			],
		})
		const { sinks } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(requests[0]?.tools).toBeDefined()
		expect(requests[2]?.tools).toBeUndefined()
		expect(r.text).toBe('Enough.')
	})

	it('marks the turn interrupted when aborted mid-stream and keeps the text so far', async () => {
		const ac = new AbortController()
		const { deps } = makeDeps([[text('Part one. '), text('Part two.'), finish()]], {
			stream: async function* (params) {
				yield text('Part one. ')
				ac.abort()
				if (params.signal.aborted) throw new DOMException('Aborted', 'AbortError')
				yield text('Part two.')
			},
		})
		const { sinks } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: ac.signal })
		expect(r.interrupted).toBe(true)
		expect(r.text).toBe('Part one. ')
	})

	it('corrects a reply that narrates tool calls as text, once', async () => {
		const junk =
			'<skill_called>a</skill_called><skill_called>b</skill_called><skill_called>c</skill_called>'
		const { deps, requests } = makeDeps([
			[text(junk), finish()],
			[text('Here is the real answer.'), finish()],
		])
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({ ...base, deps, sinks, signal: new AbortController().signal })
		expect(r.correctedPseudoToolCall).toBe(true)
		expect(log).toContain('retract')
		expect(r.text).toBe('Here is the real answer.')
		expect(requests).toHaveLength(2)
	})

	it('does not correct twice in one session', async () => {
		const junk =
			'<skill_called>a</skill_called><skill_called>b</skill_called><skill_called>c</skill_called>'
		const { deps } = makeDeps([[text(junk), finish()]])
		const { sinks, log } = makeSinks()
		const r = await runLiveTurn({
			...base,
			deps,
			sinks,
			pseudoCorrectionSpent: true,
			signal: new AbortController().signal,
		})
		expect(r.correctedPseudoToolCall).toBe(false)
		expect(log).not.toContain('retract')
	})
})
