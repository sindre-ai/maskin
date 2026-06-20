import {
	buildSessionTranscript,
	getLatestActivityPreview,
	getSessionResultDisplay,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import type { SessionLogResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

function log(
	id: number,
	stream: 'stdout' | 'stderr' | 'system',
	content: string,
): SessionLogResponse {
	return { id, sessionId: 's', stream, content, createdAt: null }
}

describe('buildSessionTranscript', () => {
	it('passes system-stream lines through as system-line items', () => {
		const items = buildSessionTranscript([log(1, 'system', 'Session completed with exit code 0')])
		expect(items).toEqual([
			{ kind: 'system-line', text: 'Session completed with exit code 0', logId: 1 },
		])
	})

	it('passes stderr-stream lines through as stderr items', () => {
		const items = buildSessionTranscript([log(1, 'stderr', 'something went wrong')])
		expect(items).toEqual([{ kind: 'stderr', text: 'something went wrong', logId: 1 }])
	})

	it('parses stdout JSON envelopes into typed events', () => {
		const assistant = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ type: 'text', text: 'hello' }],
			},
			session_id: 'sess',
		})
		const items = buildSessionTranscript([log(1, 'stdout', assistant)])
		expect(items).toHaveLength(1)
		expect(items[0].kind).toBe('event')
		if (items[0].kind !== 'event') throw new Error('unreachable')
		expect(items[0].event.kind).toBe('text')
	})

	it('falls back to plain-stdout for non-JSON stdout lines', () => {
		const items = buildSessionTranscript([log(1, 'stdout', '[system] Starting agent session: abc')])
		expect(items).toEqual([
			{ kind: 'plain-stdout', text: '[system] Starting agent session: abc', logId: 1 },
		])
	})

	it('surfaces user envelopes that carry tool_result echoes as tool_result events', () => {
		const userEnvelope = JSON.stringify({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [] }] },
		})
		expect(buildSessionTranscript([log(1, 'stdout', userEnvelope)])).toEqual([
			{
				kind: 'event',
				event: { kind: 'tool_result', toolUseId: 'tu1', isError: false, content: '' },
				logId: 1,
			},
		])
	})

	it('surfaces real user messages from interactive sessions', () => {
		const userEnvelope = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'Hey, status please' },
		})
		const items = buildSessionTranscript([log(1, 'stdout', userEnvelope)])
		expect(items).toHaveLength(1)
		expect(items[0].kind).toBe('event')
		if (items[0].kind !== 'event') throw new Error('unreachable')
		expect(items[0].event).toEqual({ kind: 'user', text: 'Hey, status please' })
	})
})

describe('getSessionResultDisplay', () => {
	it('returns the last result envelope text from stdout', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'Final answer from the agent',
		})
		expect(getSessionResultDisplay([log(1, 'stdout', result)])).toEqual({
			text: 'Final answer from the agent',
			isError: false,
		})
	})

	it('marks errored results with isError: true', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'error',
			is_error: true,
			result: 'Something failed',
		})
		expect(getSessionResultDisplay([log(1, 'stdout', result)])).toEqual({
			text: 'Something failed',
			isError: true,
		})
	})

	it('returns null when no result envelope is present', () => {
		expect(getSessionResultDisplay([log(1, 'stdout', 'plain text')])).toBeNull()
	})

	it('ignores result envelopes on non-stdout streams', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'should be ignored',
		})
		expect(getSessionResultDisplay([log(1, 'system', result)])).toBeNull()
	})
})

describe('isSessionIdleAwaitingInput', () => {
	const result = JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'done',
	})
	const errorResult = JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: true,
		result: 'Not logged in',
	})
	const assistant = JSON.stringify({
		type: 'assistant',
		message: { id: 'm1', content: [{ type: 'text', text: 'thinking…' }] },
	})
	const userInput = JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hi' },
	})

	it('is true when the most recent stdout envelope is a result', () => {
		expect(
			isSessionIdleAwaitingInput([log(1, 'stdout', assistant), log(2, 'stdout', result)]),
		).toBe(true)
	})

	it('is true even when the last result is an error (auth failure case)', () => {
		expect(
			isSessionIdleAwaitingInput([log(1, 'stdout', userInput), log(2, 'stdout', errorResult)]),
		).toBe(true)
	})

	it('is false when newer activity has happened since the last result', () => {
		expect(
			isSessionIdleAwaitingInput([
				log(1, 'stdout', result),
				log(2, 'stdout', userInput),
				log(3, 'stdout', assistant),
			]),
		).toBe(false)
	})

	it('is false when there is no result envelope yet', () => {
		expect(isSessionIdleAwaitingInput([log(1, 'stdout', assistant)])).toBe(false)
	})

	it('ignores trailing system-stream lines so a system log after a result still counts as idle', () => {
		expect(
			isSessionIdleAwaitingInput([
				log(1, 'stdout', result),
				log(2, 'system', 'Session log: idle keepalive'),
			]),
		).toBe(true)
	})

	it('is false when there are no logs', () => {
		expect(isSessionIdleAwaitingInput([])).toBe(false)
	})
})

describe('getLatestActivityPreview', () => {
	it('returns the assistant text from the most recent assistant envelope', () => {
		const assistant = JSON.stringify({
			type: 'assistant',
			message: { id: 'm', content: [{ type: 'text', text: 'Searching the workspace…' }] },
		})
		expect(getLatestActivityPreview([log(1, 'stdout', assistant)])).toBe('Searching the workspace…')
	})

	it('describes a tool_use envelope with the tool name', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm',
				content: [{ type: 'tool_use', id: 't1', name: 'search_objects', input: {} }],
			},
		})
		expect(getLatestActivityPreview([log(1, 'stdout', tool)])).toBe('Using search_objects')
	})

	it('returns "Awaiting input" when the latest envelope is a successful result', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'done',
		})
		expect(getLatestActivityPreview([log(1, 'stdout', result)])).toBe('Awaiting input')
	})

	it('returns "Errored — awaiting input" when the latest result was an error', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: true,
			result: 'Not logged in',
		})
		expect(getLatestActivityPreview([log(1, 'stdout', result)])).toBe('Errored — awaiting input')
	})

	it('skips system init envelopes and surfaces the preceding meaningful event', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm',
				content: [{ type: 'tool_use', id: 't1', name: 'list_objects', input: {} }],
			},
		})
		const systemInit = JSON.stringify({ type: 'system', subtype: 'init' })
		expect(getLatestActivityPreview([log(1, 'stdout', tool), log(2, 'stdout', systemInit)])).toBe(
			'Using list_objects',
		)
	})

	it('truncates long assistant text', () => {
		const long = 'a'.repeat(200)
		const assistant = JSON.stringify({
			type: 'assistant',
			message: { id: 'm', content: [{ type: 'text', text: long }] },
		})
		const preview = getLatestActivityPreview([log(1, 'stdout', assistant)])
		expect(preview).toBeTruthy()
		expect(preview?.length).toBeLessThanOrEqual(80)
		expect(preview?.endsWith('…')).toBe(true)
	})

	it('returns null when there is nothing renderable yet', () => {
		expect(getLatestActivityPreview([])).toBeNull()
	})
})
