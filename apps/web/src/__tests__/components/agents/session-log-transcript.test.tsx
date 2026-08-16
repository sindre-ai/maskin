import {
	buildSessionTranscript,
	getLatestActivityPreview,
	getSessionResultDisplay,
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
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

	it('skips user envelopes (tool result echoes) so they do not duplicate the tool_use', () => {
		const userEnvelope = JSON.stringify({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [] }] },
		})
		expect(buildSessionTranscript([log(1, 'stdout', userEnvelope)])).toEqual([])
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

	it('describes a user envelope generically instead of echoing the raw prompt', () => {
		const userInput = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'A new message was posted in a conversation…' },
		})
		expect(getLatestActivityPreview([log(1, 'stdout', userInput)])).toBe('The user sent a message')
	})

	it('describes a post_conversation_message tool_use as a friendly reply label', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm',
				content: [
					{ id: 't1', type: 'tool_use', name: 'mcp__maskin__post_conversation_message', input: {} },
				],
			},
		})
		expect(getLatestActivityPreview([log(1, 'stdout', tool)])).toBe('Replied to the conversation.')
	})
})

function taggedUserTurn(messageId: number, content: string): string {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content },
		maskin_message_id: messageId,
	})
}

describe('segmentActivityByMessage', () => {
	it('returns one step per meaningful event, in chronological order, for an untagged (legacy) session', () => {
		const first = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ type: 'tool_use', id: 't1', name: 'search_objects', input: {} }],
			},
		})
		const second = JSON.stringify({
			type: 'assistant',
			message: { id: 'm2', content: [{ type: 'text', text: 'Found 3 matches' }] },
		})
		const { segments, unassigned } = segmentActivityByMessage([
			log(1, 'stdout', first),
			log(2, 'stdout', second),
		])
		expect(segments).toEqual([])
		expect(unassigned).toEqual([
			{ id: '1-0', kind: 'tool_use', text: 'Using search_objects' },
			{ id: '2-0', kind: 'text', text: 'Found 3 matches' },
		])
	})

	it('omits result, system, and debug envelopes from the history', () => {
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'done',
		})
		const systemInit = JSON.stringify({ type: 'system', subtype: 'init' })
		const { segments, unassigned } = segmentActivityByMessage([
			log(1, 'stdout', systemInit),
			log(2, 'stdout', result),
			log(3, 'stdout', 'not json'),
		])
		expect(segments).toEqual([])
		expect(unassigned).toEqual([])
	})

	it('surfaces stderr lines as error steps', () => {
		const { unassigned } = segmentActivityByMessage([log(1, 'stderr', 'connection refused')])
		expect(unassigned).toEqual([{ id: '1-stderr', kind: 'error', text: 'connection refused' }])
	})

	it('returns empty segments and unassigned for no logs', () => {
		expect(segmentActivityByMessage([])).toEqual({ segments: [], unassigned: [] })
	})

	it('starts a new segment at each tagged user turn, without rendering the turn boundary itself as a step', () => {
		const tool1 = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ id: 't1', type: 'tool_use', name: 'search_objects', input: {} }],
			},
		})
		const tool2 = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm2',
				content: [{ id: 't2', type: 'tool_use', name: 'list_objects', input: {} }],
			},
		})
		const { segments, unassigned } = segmentActivityByMessage([
			log(1, 'stdout', taggedUserTurn(10, 'first message')),
			log(2, 'stdout', tool1),
			log(3, 'stdout', taggedUserTurn(20, 'second message')),
			log(4, 'stdout', tool2),
		])
		expect(unassigned).toEqual([])
		expect(segments).toEqual([
			{
				conversationMessageId: 10,
				containsReply: false,
				steps: [{ id: '2-0', kind: 'tool_use', text: 'Using search_objects' }],
			},
			{
				conversationMessageId: 20,
				containsReply: false,
				steps: [{ id: '4-0', kind: 'tool_use', text: 'Using list_objects' }],
			},
		])
	})

	it('puts steps before the first tagged boundary into unassigned instead of dropping them', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ id: 't1', type: 'tool_use', name: 'search_objects', input: {} }],
			},
		})
		const { segments, unassigned } = segmentActivityByMessage([
			log(1, 'stdout', tool),
			log(2, 'stdout', taggedUserTurn(10, 'hi')),
		])
		expect(unassigned).toEqual([{ id: '1-0', kind: 'tool_use', text: 'Using search_objects' }])
		expect(segments).toEqual([{ conversationMessageId: 10, containsReply: false, steps: [] }])
	})

	it('renames a post_conversation_message tool call to a friendly reply label and marks the segment containsReply', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ id: 't1', type: 'tool_use', name: 'post_conversation_message', input: {} }],
			},
		})
		const { segments } = segmentActivityByMessage([
			log(1, 'stdout', taggedUserTurn(10, 'hi')),
			log(2, 'stdout', tool),
		])
		expect(segments).toEqual([
			{
				conversationMessageId: 10,
				containsReply: true,
				steps: [{ id: '2-0', kind: 'tool_use', text: 'Replied to the conversation.' }],
			},
		])
	})

	it('drops the assistant wrap-up text that immediately follows a reply, so Thinking sits directly above one clean reply line', () => {
		const thinking = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ type: 'thinking', thinking: 'I should reply now.' }],
			},
		})
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm2',
				content: [
					{ id: 't1', type: 'tool_use', name: 'mcp__maskin__post_conversation_message', input: {} },
				],
			},
		})
		const wrapUpText = JSON.stringify({
			type: 'assistant',
			message: { id: 'm3', content: [{ type: 'text', text: 'Replied to the conversation.' }] },
		})
		const { segments } = segmentActivityByMessage([
			log(1, 'stdout', taggedUserTurn(10, 'hi')),
			log(2, 'stdout', thinking),
			log(3, 'stdout', tool),
			log(4, 'stdout', wrapUpText),
		])
		expect(segments).toEqual([
			{
				conversationMessageId: 10,
				containsReply: true,
				steps: [
					{ id: '2-0', kind: 'thinking', text: 'Thinking…' },
					{ id: '3-0', kind: 'tool_use', text: 'Replied to the conversation.' },
				],
			},
		])
	})

	it('keeps assistant text that follows a non-reply tool call', () => {
		const tool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ id: 't1', type: 'tool_use', name: 'search_objects', input: {} }],
			},
		})
		const text = JSON.stringify({
			type: 'assistant',
			message: { id: 'm2', content: [{ type: 'text', text: 'Found 3 matches' }] },
		})
		const { segments } = segmentActivityByMessage([
			log(1, 'stdout', taggedUserTurn(10, 'hi')),
			log(2, 'stdout', tool),
			log(3, 'stdout', text),
		])
		expect(segments).toEqual([
			{
				conversationMessageId: 10,
				containsReply: false,
				steps: [
					{ id: '2-0', kind: 'tool_use', text: 'Using search_objects' },
					{ id: '3-0', kind: 'text', text: 'Found 3 matches' },
				],
			},
		])
	})

	it('sets containsReply only on the segment that actually replied, even when a later segment does not', () => {
		const replyTool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm1',
				content: [{ id: 't1', type: 'tool_use', name: 'post_conversation_message', input: {} }],
			},
		})
		const searchTool = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'm2',
				content: [{ id: 't2', type: 'tool_use', name: 'search_objects', input: {} }],
			},
		})
		const { segments } = segmentActivityByMessage([
			log(1, 'stdout', taggedUserTurn(10, 'hi')),
			log(2, 'stdout', replyTool),
			log(3, 'stdout', taggedUserTurn(20, 'thanks')),
			log(4, 'stdout', searchTool),
		])
		expect(
			segments.map((s) => ({
				conversationMessageId: s.conversationMessageId,
				containsReply: s.containsReply,
			})),
		).toEqual([
			{ conversationMessageId: 10, containsReply: true },
			{ conversationMessageId: 20, containsReply: false },
		])
	})
})
