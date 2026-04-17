import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FesInit = {
	signal: AbortSignal
	headers: Record<string, string>
	openWhenHidden?: boolean
	onopen: () => Promise<void>
	onmessage: (msg: { event?: string; data: string; id?: string }) => void
	onerror: (err: unknown) => void
}

let lastFesInit: FesInit | null = null
const mockFetchEventSource = vi.fn(async (_url: string, init: FesInit) => {
	lastFesInit = init
})

vi.mock('@microsoft/fetch-event-source', () => ({
	fetchEventSource: (url: string, init: FesInit) => mockFetchEventSource(url, init),
}))

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			create: vi.fn(),
			input: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'test-api-key',
}))

import { loadStoredSindreSessionId, useSindreSession } from '@/hooks/use-sindre-session'
import type { SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const sindreActorId = 'actor-sindre'

function buildSession(id: string): SessionResponse {
	return {
		id,
		workspaceId,
		actorId: sindreActorId,
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Sindre interactive chat',
		config: { interactive: true },
		result: null,
		snapshotPath: null,
		startedAt: null,
		completedAt: null,
		timeoutAt: null,
		createdBy: 'user-1',
		createdAt: null,
		updatedAt: null,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	lastFesInit = null
	localStorage.clear()
})

afterEach(() => {
	localStorage.clear()
})

describe('useSindreSession — bootstrap', () => {
	it('creates an interactive session for Sindre when none is persisted', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-new'))

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})

		expect(result.current.sessionId).toBeNull()
		expect(result.current.status).toBe('starting')

		await waitFor(() => expect(api.sessions.create).toHaveBeenCalledTimes(1))
		expect(api.sessions.create).toHaveBeenCalledWith(workspaceId, {
			actor_id: sindreActorId,
			action_prompt: 'Sindre interactive chat',
			config: { interactive: true },
			auto_start: true,
		})

		await waitFor(() => expect(result.current.sessionId).toBe('sess-new'))
		expect(localStorage.getItem(`maskin-sindre-session-${workspaceId}`)).toBe('sess-new')
	})

	it('reuses a persisted sessionId without creating a new session', () => {
		localStorage.setItem(`maskin-sindre-session-${workspaceId}`, 'sess-existing')

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})

		expect(result.current.sessionId).toBe('sess-existing')
		expect(api.sessions.create).not.toHaveBeenCalled()
	})

	it('does not bootstrap when sindreActorId is null', () => {
		renderHook(() => useSindreSession({ workspaceId, sindreActorId: null }), {
			wrapper: TestWrapper,
		})
		expect(api.sessions.create).not.toHaveBeenCalled()
	})

	it('does not bootstrap when disabled', () => {
		renderHook(() => useSindreSession({ workspaceId, sindreActorId, enabled: false }), {
			wrapper: TestWrapper,
		})
		expect(api.sessions.create).not.toHaveBeenCalled()
		expect(mockFetchEventSource).not.toHaveBeenCalled()
	})

	it('exposes a load helper for the persisted sessionId', () => {
		localStorage.setItem(`maskin-sindre-session-${workspaceId}`, 'sess-x')
		expect(loadStoredSindreSessionId(workspaceId)).toBe('sess-x')
		expect(loadStoredSindreSessionId('other-ws')).toBeNull()
	})

	it('captures errors from session creation as the hook error', async () => {
		vi.mocked(api.sessions.create).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.status).toBe('error'))
		expect(result.current.error?.message).toBe('boom')
		expect(result.current.sessionId).toBeNull()
	})
})

describe('useSindreSession — SSE log stream', () => {
	beforeEach(() => {
		localStorage.setItem(`maskin-sindre-session-${workspaceId}`, 'sess-1')
	})

	it('subscribes to the session log stream with auth + workspace headers', async () => {
		renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalledTimes(1))
		expect(mockFetchEventSource).toHaveBeenCalledWith(
			'/api/sessions/sess-1/logs/stream',
			expect.objectContaining({
				headers: {
					'X-Workspace-Id': workspaceId,
					Authorization: 'Bearer test-api-key',
				},
				openWhenHidden: true,
			}),
		)
	})

	it('parses stdout lines through sindre-stream and exposes them as events', async () => {
		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})
		expect(result.current.status).toBe('ready')

		const assistantLine = JSON.stringify({
			type: 'assistant',
			session_id: 'sess-1',
			message: { id: 'msg_1', content: [{ type: 'text', text: 'hello world' }] },
		})

		act(() => lastFesInit?.onmessage({ event: 'stdout', data: assistantLine }))

		expect(result.current.events).toEqual([
			{ kind: 'text', text: 'hello world', sessionId: 'sess-1', messageId: 'msg_1' },
		])
	})

	it('emits one event per content block when the assistant envelope is multi-block', async () => {
		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})

		const multi = JSON.stringify({
			type: 'assistant',
			session_id: 'sess-1',
			message: {
				id: 'msg_2',
				content: [
					{ type: 'thinking', thinking: 'planning' },
					{ type: 'text', text: 'on it' },
				],
			},
		})
		act(() => lastFesInit?.onmessage({ event: 'stdout', data: multi }))

		expect(result.current.events.map((e) => e.kind)).toEqual(['thinking', 'text'])
	})

	it('surfaces stderr lines as debug events so the UI can collapse them', async () => {
		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})

		act(() => lastFesInit?.onmessage({ event: 'stderr', data: 'something failed' }))

		expect(result.current.events).toEqual([
			{ kind: 'debug', raw: '[stderr] something failed' },
		])
	})

	it('marks the stream as closed when the server sends a done event', async () => {
		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})

		act(() => lastFesInit?.onmessage({ event: 'done', data: 'completed' }))
		expect(result.current.status).toBe('closed')
	})

	it('aborts the SSE stream on unmount', async () => {
		const { unmount } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		expect(lastFesInit?.signal.aborted).toBe(false)
		unmount()
		expect(lastFesInit?.signal.aborted).toBe(true)
	})

	it('records SSE errors as the hook error and stops retrying', async () => {
		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		act(() => {
			expect(() => lastFesInit?.onerror(new Error('network down'))).toThrow('network down')
		})
		expect(result.current.status).toBe('error')
		expect(result.current.error?.message).toBe('network down')
	})
})

describe('useSindreSession — send', () => {
	beforeEach(() => {
		localStorage.setItem(`maskin-sindre-session-${workspaceId}`, 'sess-1')
	})

	it('posts content via api.sessions.input', async () => {
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		await act(async () => {
			await result.current.send('hello sindre')
		})

		expect(api.sessions.input).toHaveBeenCalledWith(
			'sess-1',
			{ content: 'hello sindre' },
			workspaceId,
		)
	})

	it('forwards attachments when provided', async () => {
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		const attachments = [{ kind: 'object', id: 'obj-1' }]
		await act(async () => {
			await result.current.send('what is this?', attachments)
		})

		expect(api.sessions.input).toHaveBeenCalledWith(
			'sess-1',
			{ content: 'what is this?', attachments },
			workspaceId,
		)
	})

	it('throws when called before a session is bootstrapped', async () => {
		localStorage.clear()
		const { result } = renderHook(
			() => useSindreSession({ workspaceId, sindreActorId: null }),
			{ wrapper: TestWrapper },
		)
		await expect(result.current.send('hi')).rejects.toThrow(/not ready/i)
	})
})

describe('useSindreSession — reset & workspace switching', () => {
	it('reset clears the persisted session and triggers a fresh bootstrap', async () => {
		localStorage.setItem(`maskin-sindre-session-${workspaceId}`, 'sess-old')
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-fresh'))

		const { result } = renderHook(() => useSindreSession({ workspaceId, sindreActorId }), {
			wrapper: TestWrapper,
		})
		expect(result.current.sessionId).toBe('sess-old')

		act(() => result.current.reset())
		expect(result.current.sessionId).toBeNull()
		expect(result.current.events).toEqual([])
		expect(localStorage.getItem(`maskin-sindre-session-${workspaceId}`)).toBeNull()

		await waitFor(() => expect(api.sessions.create).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(result.current.sessionId).toBe('sess-fresh'))
		expect(localStorage.getItem(`maskin-sindre-session-${workspaceId}`)).toBe('sess-fresh')
	})

	it('switches to a different persisted session when workspaceId changes', async () => {
		localStorage.setItem('maskin-sindre-session-ws-1', 'sess-ws1')
		localStorage.setItem('maskin-sindre-session-ws-2', 'sess-ws2')

		const { result, rerender } = renderHook(
			({ wsId }) => useSindreSession({ workspaceId: wsId, sindreActorId }),
			{ wrapper: TestWrapper, initialProps: { wsId: 'ws-1' } },
		)
		expect(result.current.sessionId).toBe('sess-ws1')

		rerender({ wsId: 'ws-2' })
		await waitFor(() => expect(result.current.sessionId).toBe('sess-ws2'))
		expect(api.sessions.create).not.toHaveBeenCalled()
	})
})
