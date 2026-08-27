import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			list: vi.fn(),
			logs: vi.fn(),
		},
	},
}))

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: ReactNode }) => children,
	useNavigate: () => navigateMock,
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

import {
	useConversationActivity,
	useSessionBudgetStopToast,
} from '@/hooks/use-conversation-activity'
import type { MessageResponse, SessionLogResponse, SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { toast } from 'sonner'
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
		editedAt: null,
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

function createWrapper() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
	const wrapper = ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
	return { wrapper, queryClient }
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
			{
				sessionId: 'sess-1',
				actorId: 'agent-1',
				inProgress: false,
				failed: true,
				steps: [{ kind: 'error', text: 'No available LLM credentials' }],
			},
		])
		// Logs are never fetched for a session that never ran.
		expect(api.sessions.logs).not.toHaveBeenCalled()
	})

	it('shows nothing for a timed-out session that already replied — the 2h backstop is expected, not an error', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({
				id: 'sess-1',
				status: 'timeout',
				startedAt: '2026-01-01T00:00:00.000Z',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
				result: { error: 'Session timed out' },
			}),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const messages = [
			buildMessage({ id: 10, actorId: 'human-1', content: 'hi' }),
			buildMessage({
				id: 11,
				actorId: 'agent-1',
				actorType: 'agent',
				content: 'done',
				createdAt: '2026-01-01T00:01:00.000Z',
			}),
		]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(api.sessions.list).toHaveBeenCalled())

		expect(result.current.byTriggerMessageId.size).toBe(0)
		expect(result.current.byReplyMessageId.size).toBe(0)
		expect(result.current.fallback).toEqual([])
		// Logs are never fetched for a timed-out session either.
		expect(api.sessions.logs).not.toHaveBeenCalled()
	})

	it('surfaces a timed-out session that never replied as interrupted, not as a failure', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({
				id: 'sess-1',
				status: 'timeout',
				startedAt: '2026-01-01T00:00:00.000Z',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
				result: { error: 'Session timed out' },
			}),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byTriggerMessageId.size).toBe(1))

		const turns = result.current.byTriggerMessageId.get(10)
		expect(turns).toHaveLength(1)
		expect(turns?.[0]).toMatchObject({
			sessionId: 'sess-1',
			interrupted: true,
			inProgress: false,
		})
		// Not a failure — it must not get the red "failed to start" treatment.
		expect(turns?.[0]?.failed).toBeUndefined()
		expect(turns?.[0]?.steps).toHaveLength(1)
	})

	it('surfaces a failing logs query instead of an endless contentless spinner', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }),
		])
		vi.mocked(api.sessions.logs).mockRejectedValue(new Error('403'))
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.fallback).toHaveLength(1))

		expect(result.current.fallback[0]).toMatchObject({
			sessionId: 'sess-1',
			interrupted: true,
			inProgress: false,
		})
		expect(result.current.fallback[0]?.steps[0]?.kind).toBe('error')
	})

	it('surfaces a reused session that answered an earlier turn but timed out mid-turn', async () => {
		// Regression: the suppression check used to ask "did this actor reply at
		// any point since the session started". An interactive session is reused
		// for the whole conversation, so that was true for every conversation
		// past its first exchange — the notice was suppressed on the common path
		// and the user was left with no spinner, no notice and no error.
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({
				id: 'sess-1',
				status: 'timeout',
				startedAt: '2026-01-01T00:00:00.000Z',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
			}),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const messages = [
			buildMessage({ id: 10, actorId: 'human-1', createdAt: '2026-01-01T00:00:10.000Z' }),
			buildMessage({
				id: 11,
				actorId: 'agent-1',
				actorType: 'agent',
				content: 'answer to turn 1',
				createdAt: '2026-01-01T00:01:00.000Z',
			}),
			// Turn 2 — never answered, the session was reaped instead.
			buildMessage({ id: 12, actorId: 'human-1', createdAt: '2026-01-01T00:02:00.000Z' }),
		]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byTriggerMessageId.size).toBe(1))

		// Anchored to the message actually left unanswered (12), NOT to the
		// message that created the session (10).
		expect(result.current.byTriggerMessageId.has(12)).toBe(true)
		expect(result.current.byTriggerMessageId.get(12)?.[0]).toMatchObject({
			sessionId: 'sess-1',
			interrupted: true,
			inProgress: false,
		})
	})

	it('stops a turn spinning when the logs poll starts failing after it already had logs', async () => {
		// Regression: the error branch was gated on `logs.length === 0`, which is
		// only ever true when the FIRST fetch fails. A poll that worked and then
		// broke kept its last-good data, skipped the branch and spun forever.
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('Read') }),
		])
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		// First poll succeeds — the turn is legitimately in flight.
		await waitFor(() =>
			expect(result.current.byTriggerMessageId.get(10)?.[0]).toMatchObject({
				inProgress: true,
			}),
		)

		// Every subsequent poll fails.
		vi.mocked(api.sessions.logs).mockRejectedValue(new Error('503'))
		await waitFor(
			() =>
				expect(result.current.byTriggerMessageId.get(10)?.[0]).toMatchObject({
					inProgress: false,
					interrupted: true,
				}),
			{ timeout: 5000 },
		)

		// The steps we already had are preserved, plus an error step.
		const steps = result.current.byTriggerMessageId.get(10)?.[0]?.steps ?? []
		expect(steps.length).toBeGreaterThan(1)
		expect(steps[steps.length - 1]?.kind).toBe('error')
	})

	it('prefers the classified failure_reason.human_message over a generic result.error for a session that failed mid-run', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({
				id: 'sess-1',
				status: 'failed',
				config: { conversation: { conversation_id: conversationId, message_id: 10 } },
				result: {
					exit_code: 1,
					failure_reason: {
						provider: 'anthropic',
						reason_code: 'insufficient_credits',
						human_message: 'Anthropic billing error — credit balance may be exhausted',
						http_status: null,
						reset_at: null,
						verbatim_output: null,
					},
				},
			}),
		])
		const messages = [buildMessage({ id: 10, actorId: 'human-1', content: 'hi' })]

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, messages),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.byTriggerMessageId.get(10)).toBeDefined())

		expect(result.current.byTriggerMessageId.get(10)).toMatchObject([
			{
				sessionId: 'sess-1',
				failed: true,
				steps: [
					{ kind: 'error', text: 'Anthropic billing error — credit balance may be exhausted' },
				],
			},
		])
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
			expect(api.sessions.logs).toHaveBeenCalledWith(
				'sess-2',
				workspaceId,
				expect.objectContaining({ order: 'desc' }),
			),
		)

		expect(result.current.byTriggerMessageId.get(10)).toBeUndefined()
	})

	it('surfaces a turn that ended without calling the reply tool, anchored to its trigger', async () => {
		// This used to disappear entirely: no reply tool call meant no message
		// to anchor to, so the turn vanished and the user saw silence. Its
		// end-of-turn output is now the reply, so it renders under the message
		// that triggered it.
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
			buildLog({ id: 3, content: resultEnvelope() }),
		])

		const { result } = renderHook(() => useConversationActivity(workspaceId, conversationId, []), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.byTriggerMessageId.size).toBe(1))

		const turn = result.current.byTriggerMessageId.get(10)?.[0]
		expect(turn?.inProgress).toBe(false)
		expect(turn?.pendingFinalOutput?.text).toBe('done')
		expect(result.current.byReplyMessageId.size).toBe(0)
		expect(result.current.fallback).toEqual([])
	})

	it('leaves nothing behind when a turn ends with no output at all', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([buildSession({ id: 'sess-1' })])
		vi.mocked(api.sessions.logs).mockResolvedValue([
			buildLog({ id: 1, content: taggedUserTurn(10, 'hi') }),
			buildLog({ id: 2, content: toolUse('search_objects') }),
			buildLog({
				id: 3,
				content: JSON.stringify({
					type: 'result',
					subtype: 'success',
					is_error: false,
					result: '',
				}),
			}),
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

function budgetFailureReason() {
	return {
		provider: 'maskin',
		reason_code: 'plan_cap_exceeded',
		human_message:
			'Session stopped — usage exceeded the plan cap and no usage credits are available.',
		http_status: null,
		reset_at: null,
		verbatim_output: null,
	}
}

describe('useSessionBudgetStopToast', () => {
	it('toasts the plan-limit message once a running session transitions to failed with plan_cap_exceeded', async () => {
		vi.mocked(api.sessions.list).mockResolvedValueOnce([
			buildSession({ id: 'sess-1', status: 'running' }),
		])
		const { wrapper, queryClient } = createWrapper()
		const queryKey = queryKeys.sessions.byConversation(workspaceId, conversationId)
		renderHook(() => useSessionBudgetStopToast(workspaceId, conversationId), { wrapper })
		// Wait for the *data* to land, not just for the queryFn to have been
		// called — otherwise the cache mutation below can race the in-flight
		// fetch and become the first (untoasted) observation of this session.
		await waitFor(() =>
			expect(queryClient.getQueryData(queryKey)).toMatchObject([{ status: 'running' }]),
		)
		expect(toast.error).not.toHaveBeenCalled()

		act(() => {
			queryClient.setQueryData(queryKey, [
				buildSession({
					id: 'sess-1',
					status: 'failed',
					result: { exit_code: 143, failure_reason: budgetFailureReason() },
				}),
			])
		})

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
		expect(toast.error).toHaveBeenCalledWith(
			'Plan limit reached — buy usage credits or upgrade to keep going',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Go to Billing' }) }),
		)
	})

	it('does not toast for a session that was already failed on first load', async () => {
		vi.mocked(api.sessions.list).mockResolvedValueOnce([
			buildSession({
				id: 'sess-1',
				status: 'failed',
				result: { exit_code: 143, failure_reason: budgetFailureReason() },
			}),
		])
		const { wrapper } = createWrapper()
		renderHook(() => useSessionBudgetStopToast(workspaceId, conversationId), { wrapper })
		await waitFor(() => expect(api.sessions.list).toHaveBeenCalledTimes(1))

		expect(toast.error).not.toHaveBeenCalled()
	})

	it('does not toast a running-to-failed transition for an unrelated failure reason', async () => {
		vi.mocked(api.sessions.list).mockResolvedValueOnce([
			buildSession({ id: 'sess-1', status: 'running' }),
		])
		const { wrapper, queryClient } = createWrapper()
		const queryKey = queryKeys.sessions.byConversation(workspaceId, conversationId)
		renderHook(() => useSessionBudgetStopToast(workspaceId, conversationId), { wrapper })
		await waitFor(() =>
			expect(queryClient.getQueryData(queryKey)).toMatchObject([{ status: 'running' }]),
		)

		act(() => {
			queryClient.setQueryData(queryKey, [
				buildSession({
					id: 'sess-1',
					status: 'failed',
					result: { error: 'Claude credentials not connected' },
				}),
			])
		})
		await waitFor(() =>
			expect(queryClient.getQueryData(queryKey)).toMatchObject([{ status: 'failed' }]),
		)

		expect(toast.error).not.toHaveBeenCalled()
	})
})

describe('useConversationActivity — auto-posted final output', () => {
	const sessionId = 'session-final'
	const startedAt = new Date(1000).toISOString()

	function finalResult(text: string) {
		return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })
	}

	function setup(messages: MessageResponse[], logs: SessionLogResponse[]) {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: sessionId, status: 'running', startedAt }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue(logs)
		return renderHook(() => useConversationActivity(workspaceId, conversationId, messages), {
			wrapper: TestWrapper,
		})
	}

	function turnsFor(result: { current: ReturnType<typeof useConversationActivity> }) {
		return [
			...[...result.current.byReplyMessageId.values()].flat(),
			...[...result.current.byTriggerMessageId.values()].flat(),
			...result.current.fallback,
		]
	}

	it('surfaces a closed turn result as a pending final output', async () => {
		const { result } = setup(
			[buildMessage({ id: 1, content: 'hi' })],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'hi') }),
				buildLog({ id: 2, content: finalResult('Here is the answer.') }),
			],
		)

		await waitFor(() => expect(turnsFor(result).some((t) => t.pendingFinalOutput)).toBe(true))
		const pending = turnsFor(result).find((t) => t.pendingFinalOutput)?.pendingFinalOutput
		expect(pending?.text).toBe('Here is the answer.')
		expect(pending?.isError).toBe(false)
	})

	it('does not render a failed turn raw error envelope as the agent reply', async () => {
		// The backend is either replaying this turn (2s, then 8s) or about to
		// post a written explanation. Showing the raw envelope in the meantime
		// puts `API Error: {...}` in the chat as the answer — the exact blob
		// this feature exists to keep out.
		const { result } = setup(
			[buildMessage({ id: 1, content: 'hi' })],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'hi') }),
				buildLog({
					id: 2,
					content: JSON.stringify({
						type: 'result',
						is_error: true,
						result: 'API Error: {"type":"error","error":{"type":"api_error"}}',
					}),
				}),
			],
		)

		await waitFor(() => expect(turnsFor(result).length).toBeGreaterThan(0))
		expect(turnsFor(result).every((t) => !t.pendingFinalOutput)).toBe(true)
	})

	it('keeps pairing later turns after an unanswered-replay notice', async () => {
		// The notice has no `result` envelope behind it — the replayed turn
		// never closed. Counting it would leave persistedFinalCount one ahead
		// and silently stop every later turn's text from rendering.
		const { result } = setup(
			[
				buildMessage({ id: 1, content: 'hi' }),
				buildMessage({
					id: 2,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'the run never came back',
					metadata: {
						source: 'final_output',
						final_output: { dedupe_key: 'abc-unanswered', retry: 'unanswered' },
					},
					sessionId,
				}),
				buildMessage({ id: 3, content: 'again' }),
			],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'hi') }),
				// The failed envelope was retracted by the replay, so this turn
				// contributes no result segment — matching the notice above.
				buildLog({
					id: 2,
					content: JSON.stringify({ type: 'result', is_error: true, result: 'API Error: {}' }),
				}),
				buildLog({
					id: 3,
					content: JSON.stringify({
						type: 'user',
						message: { role: 'user', content: 'hi' },
						maskin_retry: true,
					}),
				}),
				buildLog({ id: 4, content: taggedUserTurn(3, 'again') }),
				buildLog({ id: 5, content: finalResult('The later answer.') }),
			],
		)

		await waitFor(() => expect(turnsFor(result).some((t) => t.pendingFinalOutput)).toBe(true))
		const texts = turnsFor(result).map((t) => t.pendingFinalOutput?.text)
		expect(texts).toContain('The later answer.')
	})

	it('drops the pending output once the persisted message arrives', async () => {
		const { result } = setup(
			[
				buildMessage({ id: 1, content: 'hi' }),
				// The row the backend inserted for this same turn.
				buildMessage({
					id: 2,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'Here is the answer.',
					metadata: { source: 'final_output', final_output: { dedupe_key: 'abc' } },
					createdAt: new Date(2000).toISOString(),
				}),
			],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'hi') }),
				buildLog({ id: 2, content: finalResult('Here is the answer.') }),
			],
		)

		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
		// Reconciliation is derived: with the real message present there is no
		// optimistic copy, so the text can never be on screen twice.
		expect(turnsFor(result).every((t) => !t.pendingFinalOutput)).toBe(true)
	})

	it('marks only the unpersisted turn as pending when two turns have closed', async () => {
		const { result } = setup(
			[
				buildMessage({ id: 1, content: 'first' }),
				buildMessage({
					id: 2,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'first answer',
					metadata: { source: 'final_output', final_output: { dedupe_key: 'a' } },
					createdAt: new Date(2000).toISOString(),
				}),
				buildMessage({ id: 3, content: 'second' }),
			],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'first') }),
				buildLog({ id: 2, content: finalResult('first answer') }),
				buildLog({ id: 3, content: taggedUserTurn(3, 'second') }),
				buildLog({ id: 4, content: finalResult('second answer') }),
			],
		)

		await waitFor(() => expect(turnsFor(result).some((t) => t.pendingFinalOutput)).toBe(true))
		const pendingTexts = turnsFor(result)
			.map((t) => t.pendingFinalOutput?.text)
			.filter(Boolean)
		expect(pendingTexts).toEqual(['second answer'])
	})

	it('does not let a final_output message shift the MCP reply pairing', async () => {
		// The agent posted a heads-up via MCP and then ended the turn. Both are
		// agent-authored messages, but only the heads-up pairs with the
		// containsReply segment — counting the final output too would anchor
		// the dropdown under the wrong message.
		const { result } = setup(
			[
				buildMessage({ id: 1, content: 'go' }),
				buildMessage({
					id: 2,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'On it, back shortly.',
					createdAt: new Date(2000).toISOString(),
				}),
				buildMessage({
					id: 3,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'All done.',
					metadata: { source: 'final_output', final_output: { dedupe_key: 'b' } },
					createdAt: new Date(3000).toISOString(),
				}),
			],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'go') }),
				buildLog({ id: 2, content: replyTool() }),
				buildLog({ id: 3, content: finalResult('All done.') }),
			],
		)

		// The dropdown anchors to the MCP reply (message 2), not the final output.
		await waitFor(() => expect(result.current.byReplyMessageId.has(2)).toBe(true))
		expect(result.current.byReplyMessageId.has(3)).toBe(false)
	})

	it('keeps the activity dropdown after the persisted message arrives', async () => {
		// Regression: the turn used to be emitted only while its output was
		// still pending, so the thinking/tool-use dropdown vanished the moment
		// the agent's message landed — exactly when the user wants to open it.
		const { result } = setup(
			[
				buildMessage({ id: 1, content: 'go' }),
				buildMessage({
					id: 2,
					actorId: 'agent-1',
					actorType: 'agent',
					content: 'All done.',
					metadata: { source: 'final_output', final_output: { dedupe_key: 'a' } },
					createdAt: new Date(2000).toISOString(),
				}),
			],
			[
				buildLog({ id: 1, content: taggedUserTurn(1, 'go') }),
				buildLog({ id: 2, content: toolUse('search_objects') }),
				buildLog({ id: 3, content: finalResult('All done.') }),
			],
		)

		// Anchored to the message it produced, the way MCP replies pair — so
		// the trail sits directly above the answer it explains.
		await waitFor(() => expect(result.current.byReplyMessageId.has(2)).toBe(true))
		const turn = result.current.byReplyMessageId.get(2)?.[0]
		expect(turn?.steps.map((s) => s.text)).toEqual(['Using search_objects'])
		expect(turn?.pendingFinalOutput).toBeUndefined()
	})

	it('does not offer to load older activity for a short conversation', async () => {
		// Regression: any terminal session used to flip this on, and a chat
		// spawns one per turn — so the control appeared after the agent's
		// second message, offering history that was already fully on screen.
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-live', status: 'running', startedAt }),
			buildSession({ id: 'sess-old', status: 'timeout', startedAt }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const { result } = renderHook(
			() =>
				useConversationActivity(workspaceId, conversationId, [
					buildMessage({ id: 1, content: 'hi' }),
					buildMessage({ id: 2, actorId: 'agent-1', actorType: 'agent', content: 'hello' }),
				]),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
		expect(result.current.olderActivity.available).toBe(false)
	})

	it('offers to load older activity once enough replies have no trace', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'sess-old', status: 'timeout', startedAt }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const many = Array.from({ length: 25 }, (_, i) =>
			buildMessage({
				id: i + 1,
				actorId: 'agent-1',
				actorType: 'agent',
				content: `reply ${i}`,
			}),
		)

		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, many),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.olderActivity.available).toBe(true))
	})

	it('does not fetch logs for a terminal session until asked', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: sessionId, status: 'timeout', startedAt }),
		])
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		// Enough untraced replies that the control is genuinely on offer —
		// otherwise there is nothing to click and the assertion below is vacuous.
		const many = Array.from({ length: 25 }, (_, i) =>
			buildMessage({ id: i + 1, actorId: 'agent-1', actorType: 'agent', content: `reply ${i}` }),
		)
		const { result } = renderHook(
			() => useConversationActivity(workspaceId, conversationId, many),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.olderActivity.available).toBe(true))
		// Opening an old conversation must not pull thousands of log rows.
		expect(api.sessions.logs).not.toHaveBeenCalled()

		result.current.loadOlderActivity()
		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
	})
})
