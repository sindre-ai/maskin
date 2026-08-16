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
import type { SessionLogResponse, SessionResponse } from '@/lib/api'
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

function taggedUserTurn(messageId: number, content: string) {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content },
		maskin_message_id: messageId,
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
		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(api.sessions.list).toHaveBeenCalled())
		expect(result.current.byMessageId.size).toBe(0)
		expect(result.current.fallback).toEqual([])
	})

	it('groups a finished turn under the message that triggered it', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
			buildLog({ id: 3, content: resultEnvelope() }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.byMessageId.get(10)).toBeDefined())

		const turns = result.current.byMessageId.get(10)
		expect(turns).toHaveLength(1)
		expect(turns?.[0]).toMatchObject({
			sessionId: 'sess-1',
			actorId: 'agent-1',
			inProgress: false,
			steps: [{ id: '2-0', kind: 'tool_use', text: 'Using search_objects' }],
		})
		expect(result.current.fallback).toEqual([])
	})

	it('marks the last segment in-progress when the session has not reached a result envelope yet', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.byMessageId.get(10)).toBeDefined())

		expect(result.current.byMessageId.get(10)?.[0]?.inProgress).toBe(true)
	})

	it('routes an in-progress turn with no tag yet to fallback instead of dropping it', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.fallback).toHaveLength(1))

		expect(result.current.fallback[0]).toMatchObject({
			sessionId: 'sess-1',
			actorId: 'agent-1',
			inProgress: true,
			steps: [],
		})
		expect(result.current.byMessageId.size).toBe(0)
	})

	it('does not add a fallback entry once the session goes idle with no in-progress turn', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: resultEnvelope() }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.byMessageId.get(10)).toBeDefined())

		expect(result.current.fallback).toEqual([])
	})

	it("keeps each agent session's turns separate for the same triggering message in a group chat", async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-1', actorId: 'agent-1' }),
			buildSession({ id: 'sess-2', actorId: 'agent-2' }),
		])
		vi.mocked(api.sessions.logs).mockImplementation(async (sessionId: string) => {
			if (sessionId === 'sess-1') {
				return [
					buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
					buildLog({ id: 2, content: toolUse('search_objects') }),
					buildLog({ id: 3, content: resultEnvelope() }),
				]
			}
			return [
				buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
				buildLog({ id: 2, content: toolUse('list_objects') }),
				buildLog({ id: 3, content: resultEnvelope() }),
			]
		})

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.byMessageId.get(10)).toHaveLength(2))

		const sessionIds = result.current.byMessageId
			.get(10)
			?.map((t) => t.sessionId)
			.sort()
		expect(sessionIds).toEqual(['sess-1', 'sess-2'])
	})
})
