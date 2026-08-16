import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FesInit = {
	signal: AbortSignal
	headers: Record<string, string>
	openWhenHidden?: boolean
	onopen: (response?: Response) => Promise<void>
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
			logs: vi.fn(),
			input: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'test-api-key',
}))

import { useLiveSession } from '@/hooks/use-live-session'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const sessionId = 'sess-live'

beforeEach(() => {
	vi.clearAllMocks()
	lastFesInit = null
	vi.mocked(api.sessions.logs).mockResolvedValue([])
})

describe('useLiveSession — replay + SSE', () => {
	it('replays historic stdout logs on mount as chat events', async () => {
		const assistantLog = JSON.stringify({
			type: 'assistant',
			session_id: sessionId,
			message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] },
		})
		vi.mocked(api.sessions.logs).mockResolvedValue([
			{
				id: 5,
				sessionId,
				stream: 'stdout',
				content: assistantLog,
				createdAt: '2026-08-15T00:00:00Z',
			},
		])

		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0))
		expect(result.current.events[0]).toMatchObject({ kind: 'text', text: 'hello' })
	})

	it('subscribes to the SSE log stream with workspace and auth headers', async () => {
		renderHook(() => useLiveSession({ sessionId, workspaceId }), { wrapper: TestWrapper })
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		expect(mockFetchEventSource).toHaveBeenCalledWith(
			`/api/sessions/${sessionId}/logs/stream`,
			expect.objectContaining({
				headers: expect.objectContaining({
					'X-Workspace-Id': workspaceId,
					Authorization: 'Bearer test-api-key',
				}),
				openWhenHidden: true,
			}),
		)
	})

	it('passes Last-Event-ID equal to the highest replayed log id on open', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([
			{ id: 3, sessionId, stream: 'stdout', content: '{"type":"system"}', createdAt: null },
			{ id: 7, sessionId, stream: 'stderr', content: 'warn', createdAt: null },
		])

		renderHook(() => useLiveSession({ sessionId, workspaceId }), { wrapper: TestWrapper })
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		expect(lastFesInit?.headers['Last-Event-ID']).toBe('7')
	})

	it('parses stdout envelopes streamed over SSE into chat events', async () => {
		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})
		expect(result.current.status).toBe('ready')

		const line = JSON.stringify({
			type: 'assistant',
			session_id: sessionId,
			message: { id: 'msg_x', content: [{ type: 'text', text: 'streamed' }] },
		})
		act(() => lastFesInit?.onmessage({ event: 'stdout', data: line }))
		expect(result.current.events.some((e) => e.kind === 'text' && e.text === 'streamed')).toBe(true)
	})

	it('marks the stream closed on the server-side done event', async () => {
		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})
		act(() => lastFesInit?.onmessage({ event: 'done', data: 'completed' }))
		expect(result.current.status).toBe('closed')
	})

	it('surfaces a 4xx SSE open as a fatal error and stops retrying', async () => {
		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await expect(lastFesInit?.onopen({ ok: false, status: 404 } as Response)).rejects.toThrow(
				/HTTP 404/,
			)
		})
		expect(result.current.status).toBe('error')
	})
})

describe('useLiveSession — send', () => {
	it('optimistically appends a user event and posts to /input', async () => {
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })
		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})

		// Wait for the initial replay to publish so it doesn't race the
		// optimistic user event.
		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		await act(async () => {
			await result.current.send('what next?')
		})

		expect(api.sessions.input).toHaveBeenCalledWith(
			sessionId,
			{ content: 'what next?' },
			workspaceId,
		)
		expect(result.current.events.some((e) => e.kind === 'user' && e.text === 'what next?')).toBe(
			true,
		)
	})

	it('rejects when there is no session id', async () => {
		const { result } = renderHook(() => useLiveSession({ sessionId: null, workspaceId }), {
			wrapper: TestWrapper,
		})
		await expect(result.current.send('hi')).rejects.toThrow(/no conversation/i)
		expect(api.sessions.input).not.toHaveBeenCalled()
	})

	it('captures a failed send as the hook error and rethrows for the caller', async () => {
		vi.mocked(api.sessions.input).mockRejectedValue(new Error('offline'))
		const { result } = renderHook(() => useLiveSession({ sessionId, workspaceId }), {
			wrapper: TestWrapper,
		})

		await act(async () => {
			await expect(result.current.send('hi')).rejects.toThrow('offline')
		})
		expect(result.current.error?.message).toBe('offline')
	})
})

describe('useLiveSession — session switching', () => {
	it('resets transcript when the sessionId changes', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([
			{
				id: 1,
				sessionId: 'a',
				stream: 'stdout',
				content: JSON.stringify({
					type: 'assistant',
					session_id: 'a',
					message: { id: 'm1', content: [{ type: 'text', text: 'first' }] },
				}),
				createdAt: null,
			},
		])
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([])

		const { result, rerender } = renderHook(
			({ id }) => useLiveSession({ sessionId: id, workspaceId }),
			{ wrapper: TestWrapper, initialProps: { id: 'a' } },
		)
		await waitFor(() => expect(result.current.events.length).toBe(1))

		rerender({ id: 'b' })
		expect(result.current.events).toEqual([])
	})
})
