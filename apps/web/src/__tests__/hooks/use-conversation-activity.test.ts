import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			list: vi.fn(),
			logs: vi.fn(),
		},
	},
}))

import { useConversationActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse, SessionLogResponse, SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const conversationId = 'conv-1'

function buildSession(overrides: Partial<SessionResponse> & { id: string }): SessionResponse {
	return {
		workspaceId,
		actorId: 'agent-1',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: '',
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: null,
		completedAt: null,
		timeoutAt: null,
		createdBy: 'agent-1',
		createdAt: null,
		updatedAt: null,
		currentActivity: null,
		...overrides,
	}
}

function buildLog(overrides: Partial<SessionLogResponse> & { id: number }): SessionLogResponse {
	return {
		sessionId: 'session-1',
		stream: 'stdout',
		content: '',
		createdAt: null,
		...overrides,
	}
}

function buildMessage(overrides: Partial<MessageResponse> & { id: number }): MessageResponse {
	return {
		conversationId,
		actorId: 'human-1',
		actorName: 'User',
		actorType: 'human',
		kind: 'message',
		content: '',
		metadata: null,
		sessionId: null,
		createdAt: null,
		...overrides,
	}
}

function taggedUserTurn(messageId: number, content: string) {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content },
		maskin_message_id: messageId,
	})
}

function replyTool() {
	return JSON.stringify({
		type: 'assistant',
		message: {
			id: 'm',
			content: [{ id: 't', type: 'tool_use', name: 'post_conversation_message', input: {} }],
		},
	})
}

function toolUse(name: string) {
	return JSON.stringify({
		type: 'assistant',
		message: { id: 'm', content: [{ id: 't', type: 'tool_use', name, input: {} }] },
	})
}

function resultEnvelope() {
	return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useConversationActivity', () => {
	it('returns empty state when the conversation has no active sessions', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([])
		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(api.sessions.list).toHaveBeenCalled())
		expect(result.current.byReplyMessageId.size).toBe(0)
		expect(result.current.byTriggerMessageId.size).toBe(0)
		expect(result.current.fallback).toEqual([])
	})

	it('anchors a finished turn to the reply message it produced, not the trigger — paired by actorId, not the (often-null) messages.sessionId', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: replyTool() }),
			buildLog({ id: 3, content: resultEnvelope() }),
		])
		const messages = [
			buildMessage({ id: 10, actorId: 'human-1', content: 'hi' }),
			// sessionId intentionally omitted — agents using the HTTP-transport
			// MCP preset never get this populated (see the hook's doc comment).
			buildMessage({ id: 11, actorId: 'agent-1', content: 'Hi there' }),
		]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byReplyMessageId.get(11)).toBeDefined())

		expect(result.current.byReplyMessageId.get(11)).toMatchObject([
			{ sessionId: 'sess-1', actorId: 'agent-1', inProgress: false },
		])
		// Not anchored to the trigger anymore — it's resolved.
		expect(result.current.byTriggerMessageId.get(10)).toBeUndefined()
	})

	it("excludes an older, already-dead session's messages from the same actor when pairing", async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-2', actorId: 'agent-1', startedAt: '2026-01-01T00:10:00.000Z' }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(12, 'still there?') }),
			buildLog({ id: 2, content: replyTool() }),
			buildLog({ id: 3, content: resultEnvelope() }),
		])
		const messages = [
			// From a prior, now-dead session for this same agent — posted before
			// the new session started, must not be treated as this turn's reply.
			buildMessage({ id: 10, actorId: 'agent-1', createdAt: '2026-01-01T00:00:00.000Z' }),
			buildMessage({ id: 11, actorId: 'human-1', createdAt: '2026-01-01T00:10:30.000Z' }),
			buildMessage({ id: 12, actorId: 'agent-1', createdAt: '2026-01-01T00:11:00.000Z' }),
		]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byReplyMessageId.get(12)).toBeDefined())

		// Paired with the newer message (12), never the stale pre-session one (10).
		expect(result.current.byReplyMessageId.get(10)).toBeUndefined()
		expect(result.current.byReplyMessageId.get(12)).toMatchObject([{ sessionId: 'sess-2' }])
	})

	it('keeps a still-in-progress turn anchored to its trigger message', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
		])
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byTriggerMessageId.get(10)).toBeDefined())

		expect(result.current.byTriggerMessageId.get(10)).toMatchObject([
			{ sessionId: 'sess-1', actorId: 'agent-1', inProgress: true },
		])
		expect(result.current.byReplyMessageId.size).toBe(0)
	})

	it('routes an in-progress turn with no tag yet to fallback instead of dropping it', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.fallback).toHaveLength(1))

		expect(result.current.fallback[0]).toMatchObject({
			sessionId: 'sess-1',
			actorId: 'agent-1',
			inProgress: true,
			steps: [],
		})
	})

	it('does not add a fallback entry once the session goes idle with no in-progress turn', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: resultEnvelope() }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())

		expect(result.current.fallback).toEqual([])
	})

	// Regression for the group-chat bug: "hi guys" triggers two agents at
	// once. Both should show live under the trigger until they resolve; once
	// one replies, only its own reply message keeps a dropdown — the other
	// agent's still-live turn stays under the trigger on its own.
	it('group chat: each agent triggered by the same message gets its own dropdown, and a finished one moves off the trigger', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-1', actorId: 'agent-1' }),
			buildSession({ id: 'sess-2', actorId: 'agent-2' }),
		])
		vi.mocked(api.sessions.logs).mockImplementation(async (sessionId: string) => {
			if (sessionId === 'sess-1') {
				// agent-1 already replied and finished.
				return [
					buildLog({ id: 1, content: taggedUserTurn(10, 'hi guys') }),
					buildLog({ id: 2, content: replyTool() }),
					buildLog({ id: 3, content: resultEnvelope() }),
				]
			}
			// agent-2 is still working on the same trigger.
			return [
				buildLog({ id: 1, content: taggedUserTurn(10, 'hi guys') }),
				buildLog({ id: 2, content: toolUse('search_objects') }),
			]
		})
		const messages = [
			buildMessage({ id: 10, actorId: 'human-1', content: 'hi guys' }),
			buildMessage({ id: 11, actorId: 'agent-1', sessionId: 'sess-1', content: 'Hey there' }),
		]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byReplyMessageId.get(11)).toBeDefined())

		expect(result.current.byReplyMessageId.get(11)).toMatchObject([{ sessionId: 'sess-1' }])
		// Only agent-2 is still under the trigger — agent-1 moved to its reply.
		expect(result.current.byTriggerMessageId.get(10)).toMatchObject([{ sessionId: 'sess-2' }])
	})

	it('surfaces a failed session as an error turn anchored to its trigger message', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({
				id: 'sess-1',
				status: 'failed',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
				result: { error: 'No available LLM credentials' },
			}),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byTriggerMessageId.get(10)).toBeDefined())

		expect(result.current.byTriggerMessageId.get(10)).toMatchObject([
			{ sessionId: 'sess-1', actorId: 'agent-1', inProgress: false, failed: true },
		])
		// Logs are never fetched for a session that never ran.
		expect(api.sessions.logs).not.toHaveBeenCalled()
	})

	it('routes a failed session with no tagged trigger message to fallback', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-1', status: 'failed', config: null }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.fallback).toHaveLength(1))

		expect(result.current.fallback[0]).toMatchObject({
			sessionId: 'sess-1',
			actorId: 'agent-1',
			failed: true,
		})
	})

	it('only surfaces the latest session per actor, so a retried session supersedes an earlier failure', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			// Newest first, matching the backend's orderBy(desc(createdAt)).
			buildSession({ id: 'sess-2', actorId: 'agent-1', status: 'running' }),
			buildSession({
				id: 'sess-1',
				actorId: 'agent-1',
				status: 'failed',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
			}),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() =>
			expect(api.sessions.logs).toHaveBeenCalledWith('sess-2', workspaceId, {
				limit: '500',
			}),
		)

		expect(result.current.byTriggerMessageId.get(10)).toBeUndefined()
	})

	it('a turn that resolves without posting a reply disappears once idle, instead of leaving an orphaned dropdown', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
			buildLog({ id: 3, content: resultEnvelope() }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())

		expect(result.current.byTriggerMessageId.size).toBe(0)
		expect(result.current.byReplyMessageId.size).toBe(0)
		expect(result.current.fallback).toEqual([])
	})
})
