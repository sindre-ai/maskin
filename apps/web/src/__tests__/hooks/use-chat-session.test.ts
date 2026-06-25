import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
			create: vi.fn(),
			input: vi.fn(),
			// Lazy bootstrap polls GET /sessions/:id until status === 'running';
			// default the mock to "already running" so tests don't hang.
			get: vi.fn(),
			// Hydration from localStorage replays via /logs.
			logs: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'test-api-key',
}))

import { useChatSession } from '@/hooks/use-chat-session'
import type { SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const agentActorId = 'actor-agent'

function buildSession(id: string): SessionResponse {
	return {
		id,
		workspaceId,
		actorId: agentActorId,
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Workspace Coach interactive chat',
		config: { interactive: true },
		result: null,
		snapshotPath: null,
		startedAt: null,
		completedAt: null,
		timeoutAt: null,
		createdBy: 'user-1',
		createdAt: null,
		updatedAt: null,
		currentActivity: null,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	lastFesInit = null
	localStorage.clear()
	// Default: pretend the container is already running so waitForRunning
	// returns immediately. Individual tests can override.
	vi.mocked(api.sessions.get).mockResolvedValue(buildSession('sess-running'))
})

afterEach(() => {
	localStorage.clear()
})

describe('useChatSession — bootstrap', () => {
	it('does not create a session on mount — lazy bootstrap waits for send()', () => {
		renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})
		expect(api.sessions.create).not.toHaveBeenCalled()
		expect(mockFetchEventSource).not.toHaveBeenCalled()
	})

	it('creates the session on the first send() and waits for running', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-new'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

		await act(async () => {
			await result.current.send('hi')
		})

		expect(api.sessions.create).toHaveBeenCalledTimes(1)
		expect(api.sessions.create).toHaveBeenCalledWith(workspaceId, {
			actor_id: agentActorId,
			action_prompt: 'Workspace Coach interactive chat',
			config: { interactive: true },
			auto_start: true,
		})
		expect(api.sessions.get).toHaveBeenCalledWith('sess-new', workspaceId)
		expect(result.current.sessionId).toBe('sess-new')
	})

	it('throws from send() when agentActorId is null', async () => {
		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId: null }), {
			wrapper: TestWrapper,
		})
		await expect(result.current.send('hi')).rejects.toThrow(/not available/i)
		expect(api.sessions.create).not.toHaveBeenCalled()
	})

	it('captures errors from session creation as the hook error', async () => {
		vi.mocked(api.sessions.create).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

		await act(async () => {
			await expect(result.current.send('hi')).rejects.toThrow('boom')
		})
		expect(result.current.status).toBe('error')
		expect(result.current.error?.message).toBe('boom')
		expect(result.current.sessionId).toBeNull()
	})
})

async function renderAndBootstrap() {
	vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-1'))
	vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })
	const hook = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
		wrapper: TestWrapper,
	})
	// Trigger lazy bootstrap via send().
	await act(async () => {
		await hook.result.current.send('hi')
	})
	await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
	return hook
}

describe('useChatSession — SSE log stream', () => {
	it('subscribes to the session log stream with auth + workspace headers', async () => {
		await renderAndBootstrap()
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

	it('parses stdout lines through chat-stream and exposes them as events', async () => {
		const { result } = await renderAndBootstrap()
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
			{ kind: 'user', text: 'hi' },
			{ kind: 'text', text: 'hello world', sessionId: 'sess-1', messageId: 'msg_1' },
		])
	})

	it('emits one event per content block when the assistant envelope is multi-block', async () => {
		const { result } = await renderAndBootstrap()
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

		expect(result.current.events.map((e) => e.kind)).toEqual(['user', 'thinking', 'text'])
	})

	it('surfaces stderr lines as debug events so the UI can collapse them', async () => {
		const { result } = await renderAndBootstrap()
		await act(async () => {
			await lastFesInit?.onopen()
		})

		act(() => lastFesInit?.onmessage({ event: 'stderr', data: 'something failed' }))

		expect(result.current.events).toEqual([
			{ kind: 'user', text: 'hi' },
			{ kind: 'debug', raw: '[stderr] something failed' },
		])
	})

	it('marks the stream as closed when the server sends a done event', async () => {
		const { result } = await renderAndBootstrap()
		await act(async () => {
			await lastFesInit?.onopen()
		})

		act(() => lastFesInit?.onmessage({ event: 'done', data: 'completed' }))
		expect(result.current.status).toBe('closed')
	})

	it('aborts the SSE stream on unmount', async () => {
		const { unmount } = await renderAndBootstrap()
		expect(lastFesInit?.signal.aborted).toBe(false)
		unmount()
		expect(lastFesInit?.signal.aborted).toBe(true)
	})

	it('records SSE errors as the hook error without flipping status (transient)', async () => {
		const { result } = await renderAndBootstrap()
		await act(async () => {
			await lastFesInit?.onopen()
		})
		expect(result.current.status).toBe('ready')

		act(() => {
			// Transient errors must not change status — fetch-event-source
			// retries automatically, and flipping to 'error' would release
			// the UI's pending spinner mid-retry.
			lastFesInit?.onerror(new Error('network down'))
		})
		expect(result.current.status).toBe('ready')
		expect(result.current.error?.message).toBe('network down')
	})

	it('throws from onopen on 4xx to stop retries', async () => {
		const { result } = await renderAndBootstrap()
		const badResponse = { ok: false, status: 404 } as Response
		await act(async () => {
			await expect(lastFesInit?.onopen(badResponse)).rejects.toThrow('HTTP 404')
		})
		expect(result.current.status).toBe('error')
		expect(result.current.error?.message).toMatch(/HTTP 404/)
	})
})

describe('useChatSession — send', () => {
	beforeEach(() => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-1'))
	})

	it('posts content via api.sessions.input', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-1'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

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
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-1'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

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

	it('throws when called without an agent actor', async () => {
		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId: null }), {
			wrapper: TestWrapper,
		})
		await expect(result.current.send('hi')).rejects.toThrow(/not available/i)
	})
})

describe('useChatSession — reset & workspace switching', () => {
	it('reset clears the session; the next send() creates a fresh one', async () => {
		vi.mocked(api.sessions.create)
			.mockResolvedValueOnce(buildSession('sess-old'))
			.mockResolvedValueOnce(buildSession('sess-fresh'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.send('first')
		})
		expect(result.current.sessionId).toBe('sess-old')

		act(() => result.current.reset())
		expect(result.current.sessionId).toBeNull()
		expect(result.current.events).toEqual([])

		await act(async () => {
			await result.current.send('second')
		})
		expect(api.sessions.create).toHaveBeenCalledTimes(2)
		expect(result.current.sessionId).toBe('sess-fresh')
	})

	it('forgets the session when the workspaceId changes; next send bootstraps again', async () => {
		vi.mocked(api.sessions.create)
			.mockResolvedValueOnce(buildSession('sess-ws1'))
			.mockResolvedValueOnce(buildSession('sess-ws2'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result, rerender } = renderHook(
			({ wsId }) => useChatSession({ workspaceId: wsId, agentActorId }),
			{ wrapper: TestWrapper, initialProps: { wsId: 'ws-1' } },
		)
		await act(async () => {
			await result.current.send('first')
		})
		expect(result.current.sessionId).toBe('sess-ws1')

		rerender({ wsId: 'ws-2' })
		expect(result.current.sessionId).toBeNull()

		await act(async () => {
			await result.current.send('second')
		})
		expect(result.current.sessionId).toBe('sess-ws2')
		expect(api.sessions.create).toHaveBeenCalledTimes(2)
	})

	it('bootstraps a fresh session on the next send when the previous session closed, preserving the transcript', async () => {
		vi.mocked(api.sessions.create)
			.mockResolvedValueOnce(buildSession('sess-old'))
			.mockResolvedValueOnce(buildSession('sess-new'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

		await act(async () => {
			await result.current.send('first')
		})
		expect(result.current.sessionId).toBe('sess-old')

		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		await act(async () => {
			await lastFesInit?.onopen()
		})
		// Server signals the session ended (idle timeout / container exit).
		act(() => lastFesInit?.onmessage({ event: 'done', data: 'completed' }))
		expect(result.current.status).toBe('closed')

		// The composer is enabled while closed and the user keeps typing — the
		// next send() must spin up a fresh session rather than POSTing to the
		// dead one.
		await act(async () => {
			await result.current.send('second')
		})

		expect(api.sessions.create).toHaveBeenCalledTimes(2)
		expect(result.current.sessionId).toBe('sess-new')
		expect(api.sessions.input).toHaveBeenLastCalledWith(
			'sess-new',
			{ content: 'second' },
			workspaceId,
		)
		// Transcript carries across the re-bootstrap.
		expect(result.current.events.map((e: { kind: string }) => e.kind)).toEqual(['user', 'user'])
	})
})

describe('useChatSession — persistence and reload', () => {
	// AC-T2 + AC-U4: a successful send writes the sessionId to localStorage
	// keyed by (workspaceId, agentActorId) so the next mount can pick the
	// same conversation back up.
	it('persists the sessionId in localStorage after a successful send', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-persisted'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.send('hi')
		})

		expect(localStorage.getItem(`maskin.chat.sessionId:${workspaceId}:${agentActorId}`)).toBe(
			'sess-persisted',
		)
	})

	it('clears the persisted sessionId on reset()', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-A'))
		vi.mocked(api.sessions.input).mockResolvedValue({ ok: true as const })

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})
		await act(async () => {
			await result.current.send('hi')
		})
		act(() => {
			result.current.reset()
		})

		expect(localStorage.getItem(`maskin.chat.sessionId:${workspaceId}:${agentActorId}`)).toBeNull()
	})

	// AC-U4: reload renders the prior conversation — including any image
	// attachments — from /logs alone. No second POST to /files is required.
	it('hydrates the transcript from /logs on mount when a sessionId is persisted', async () => {
		localStorage.setItem(`maskin.chat.sessionId:${workspaceId}:${agentActorId}`, 'sess-prev')
		const userLog = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'look at this' },
			maskin_attachments: [
				{
					kind: 'file',
					id: 'file-99',
					name: 'photo.png',
					mime_type: 'image/png',
					size_bytes: 1234,
				},
			],
		})
		const assistantLog = JSON.stringify({
			type: 'assistant',
			session_id: 'sess-prev',
			message: { id: 'msg_1', content: [{ type: 'text', text: 'I see it' }] },
		})
		vi.mocked(api.sessions.logs).mockResolvedValue([
			{
				id: 11,
				sessionId: 'sess-prev',
				stream: 'stdout',
				content: userLog,
				createdAt: '2026-06-25T20:00:00Z',
			},
			{
				id: 12,
				sessionId: 'sess-prev',
				stream: 'stdout',
				content: assistantLog,
				createdAt: '2026-06-25T20:00:01Z',
			},
		])

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.sessionId).toBe('sess-prev'))
		await waitFor(() => expect(result.current.events.length).toBeGreaterThanOrEqual(2))

		expect(api.sessions.logs).toHaveBeenCalledWith('sess-prev', workspaceId, { limit: '500' })
		const [userEvent, assistantEvent] = result.current.events
		expect(userEvent).toMatchObject({
			kind: 'user',
			text: 'look at this',
			attachments: [
				{
					kind: 'file',
					id: 'file-99',
					name: 'photo.png',
					mimeType: 'image/png',
					sizeBytes: 1234,
				},
			],
		})
		expect(assistantEvent).toMatchObject({ kind: 'text', text: 'I see it' })

		// The SSE connection that follows hydration must skip the rows we
		// already drained — passes Last-Event-ID equal to the max log id
		// returned from /logs so the server replays nothing.
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())
		expect(lastFesInit?.headers['Last-Event-ID']).toBe('12')
	})

	it('drops a stale persisted sessionId when /logs rejects', async () => {
		localStorage.setItem(`maskin.chat.sessionId:${workspaceId}:${agentActorId}`, 'sess-gone')
		vi.mocked(api.sessions.logs).mockRejectedValue(new Error('not found'))

		const { result } = renderHook(() => useChatSession({ workspaceId, agentActorId }), {
			wrapper: TestWrapper,
		})

		await waitFor(() =>
			expect(
				localStorage.getItem(`maskin.chat.sessionId:${workspaceId}:${agentActorId}`),
			).toBeNull(),
		)
		expect(result.current.sessionId).toBeNull()
		expect(result.current.events).toEqual([])
	})
})
