import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAgentReplyFromLogChunks, persistAgentChatReply } from '../../services/chat-reply'

const SUCCESS_RESULT = (text: string) =>
	JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 1234,
		result: text,
	})

const ASSISTANT_TEXT = (text: string) =>
	JSON.stringify({
		type: 'assistant',
		message: { id: 'msg_1', content: [{ type: 'text', text }] },
	})

describe('parseAgentReplyFromLogChunks', () => {
	it('returns null on empty input', () => {
		expect(parseAgentReplyFromLogChunks([])).toBeNull()
		expect(parseAgentReplyFromLogChunks([''])).toBeNull()
		expect(parseAgentReplyFromLogChunks(['\n\n'])).toBeNull()
	})

	it('extracts the result.text from a stream-json success result', () => {
		const log = `${ASSISTANT_TEXT('Hello there')}\n${SUCCESS_RESULT('Hello there, how can I help?')}\n`
		expect(parseAgentReplyFromLogChunks([log])).toBe('Hello there, how can I help?')
	})

	it('prefers result.text over assistant text blocks when both present', () => {
		const log = `${ASSISTANT_TEXT('partial')}\n${SUCCESS_RESULT('final answer')}\n`
		expect(parseAgentReplyFromLogChunks([log])).toBe('final answer')
	})

	it('falls back to concatenated assistant text blocks when no result envelope is present', () => {
		const log = `${ASSISTANT_TEXT('First line.')}\n${ASSISTANT_TEXT('Second line.')}\n`
		expect(parseAgentReplyFromLogChunks([log])).toBe('First line.\n\nSecond line.')
	})

	it('falls back to assistant text when the result is an error', () => {
		const errorResult = JSON.stringify({
			type: 'result',
			subtype: 'error',
			is_error: true,
			result: 'should be ignored',
		})
		const log = `${ASSISTANT_TEXT('Partial reply before error')}\n${errorResult}\n`
		expect(parseAgentReplyFromLogChunks([log])).toBe('Partial reply before error')
	})

	it('joins assistant text blocks across multiple chunks (Docker multiplex split)', () => {
		const line = ASSISTANT_TEXT('split across chunks')
		const half = Math.floor(line.length / 2)
		const a = line.slice(0, half)
		const b = `${line.slice(half)}\n`
		expect(parseAgentReplyFromLogChunks([a, b])).toBe('split across chunks')
	})

	it('skips non-JSON debug lines without crashing', () => {
		const log = `not json\n${SUCCESS_RESULT('clean reply')}\nmore junk\n`
		expect(parseAgentReplyFromLogChunks([log])).toBe('clean reply')
	})

	it('skips assistant tool_use blocks and only persists text blocks', () => {
		const mixed = JSON.stringify({
			type: 'assistant',
			message: {
				id: 'msg_2',
				content: [
					{ type: 'text', text: 'Looking at the codebase…' },
					{ type: 'tool_use', id: 't_1', name: 'Grep', input: {} },
					{ type: 'text', text: 'Found it.' },
				],
			},
		})
		expect(parseAgentReplyFromLogChunks([`${mixed}\n`])).toBe(
			'Looking at the codebase…\n\nFound it.',
		)
	})

	it('returns null when the only assistant content is non-text (tool_use only)', () => {
		const onlyTool = JSON.stringify({
			type: 'assistant',
			message: { id: 'msg_3', content: [{ type: 'tool_use', id: 't_1', name: 'Grep', input: {} }] },
		})
		expect(parseAgentReplyFromLogChunks([`${onlyTool}\n`])).toBeNull()
	})

	it('returns null when result.result is empty / whitespace and no assistant text exists', () => {
		const log = `${SUCCESS_RESULT('   ')}\n`
		expect(parseAgentReplyFromLogChunks([log])).toBeNull()
	})
})

const mockAppendCommentEvent = vi.fn()
vi.mock('../../services/comments', () => ({
	appendCommentEvent: (...args: unknown[]) => mockAppendCommentEvent(...args),
}))

describe('persistAgentChatReply', () => {
	beforeEach(() => {
		mockAppendCommentEvent.mockReset()
	})

	const conversationId = '11111111-1111-1111-1111-111111111111'
	const workspaceId = '22222222-2222-2222-2222-222222222222'
	const actorId = '33333333-3333-3333-3333-333333333333'

	// biome-ignore lint/suspicious/noExplicitAny: minimal stubs for test isolation
	const db = {} as any
	// biome-ignore lint/suspicious/noExplicitAny: minimal stubs for test isolation
	const sessionManager = {} as any

	it('writes a commented event with the parsed reply text when one is present', async () => {
		mockAppendCommentEvent.mockResolvedValue({ id: 99 })
		const log = `${SUCCESS_RESULT('Here is the answer.')}\n`

		const result = await persistAgentChatReply({
			db,
			sessionManager,
			workspaceId,
			actorId,
			conversationId,
			logChunks: [log],
		})

		expect(result).toEqual({ id: 99 })
		expect(mockAppendCommentEvent).toHaveBeenCalledTimes(1)
		expect(mockAppendCommentEvent).toHaveBeenCalledWith({
			db,
			sessionManager,
			workspaceId,
			actorId,
			entityType: 'object',
			entityId: conversationId,
			content: 'Here is the answer.',
		})
	})

	it('returns null and does NOT write a comment when the tail has no reply', async () => {
		const result = await persistAgentChatReply({
			db,
			sessionManager,
			workspaceId,
			actorId,
			conversationId,
			logChunks: [],
		})

		expect(result).toBeNull()
		expect(mockAppendCommentEvent).not.toHaveBeenCalled()
	})

	it('persists the assistant-text fallback when result envelope is missing', async () => {
		mockAppendCommentEvent.mockResolvedValue({ id: 100 })
		const log = `${ASSISTANT_TEXT('Partial.')}\n`

		await persistAgentChatReply({
			db,
			sessionManager,
			workspaceId,
			actorId,
			conversationId,
			logChunks: [log],
		})

		expect(mockAppendCommentEvent).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'Partial.', entityId: conversationId }),
		)
	})
})
