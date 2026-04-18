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
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'test-api-key',
}))

import { useSindreOneShot } from '@/hooks/use-sindre-one-shot'
import type { SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

function buildSession(id: string): SessionResponse {
	return {
		id,
		workspaceId: 'ws-1',
		actorId: 'actor-reviewer',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'review this',
		config: null,
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
})

afterEach(() => {
	lastFesInit = null
})

describe('useSindreOneShot — send', () => {
	it('creates a one-shot session with message + attached-object context in action_prompt', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-one-shot'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		expect(result.current.status).toBe('idle')

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
				content: 'please review',
				objects: [{ id: 'obj-1', title: 'PR #42', type: 'task' }],
			})
		})

		expect(api.sessions.create).toHaveBeenCalledTimes(1)
		expect(api.sessions.create).toHaveBeenCalledWith('ws-1', {
			actor_id: 'actor-reviewer',
			action_prompt: 'please review\n\n---\nContext objects:\n- PR #42 (task) — id: obj-1',
			auto_start: true,
		})

		expect(result.current.sessionId).toBe('sess-one-shot')
		expect(result.current.status).toBe('streaming')
	})

	it('skips the context block when there are no attached objects', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-bare'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
				content: 'look at this',
			})
		})

		expect(api.sessions.create).toHaveBeenCalledWith('ws-1', {
			actor_id: 'actor-reviewer',
			action_prompt: 'look at this',
			auto_start: true,
		})
	})

	it('subscribes to the session log stream with auth + workspace headers', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-x'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer' },
				content: 'hi',
			})
		})

		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalledTimes(1))
		expect(mockFetchEventSource).toHaveBeenCalledWith(
			'/api/sessions/sess-x/logs/stream',
			expect.objectContaining({
				headers: {
					'X-Workspace-Id': 'ws-1',
					Authorization: 'Bearer test-api-key',
				},
				openWhenHidden: true,
			}),
		)
	})

	it('parses stdout lines through sindre-stream and exposes them as events', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-y'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer' },
				content: 'hi',
			})
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		const assistantLine = JSON.stringify({
			type: 'assistant',
			session_id: 'sess-y',
			message: { id: 'msg_1', content: [{ type: 'text', text: 'Looks good' }] },
		})

		act(() => lastFesInit?.onmessage({ event: 'stdout', data: assistantLine }))

		expect(result.current.events).toEqual([
			{ kind: 'text', text: 'Looks good', sessionId: 'sess-y', messageId: 'msg_1' },
		])
	})

	it('sets status to closed when the SSE stream signals done', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-done'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer' },
				content: 'hi',
			})
		})
		await waitFor(() => expect(mockFetchEventSource).toHaveBeenCalled())

		act(() => lastFesInit?.onmessage({ event: 'done', data: '' }))

		await waitFor(() => expect(result.current.status).toBe('closed'))
	})

	it('captures errors from session creation as the hook error', async () => {
		vi.mocked(api.sessions.create).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		let caught: unknown = null
		await act(async () => {
			try {
				await result.current.send({
					workspaceId: 'ws-1',
					agent: { id: 'actor-reviewer' },
					content: 'hi',
				})
			} catch (err) {
				caught = err
			}
		})

		expect((caught as Error).message).toBe('boom')
		await waitFor(() => expect(result.current.status).toBe('error'))
		expect(result.current.error?.message).toBe('boom')
		expect(mockFetchEventSource).not.toHaveBeenCalled()
	})

	it('refuses to send without a selected agent id', async () => {
		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await expect(
			act(async () => {
				await result.current.send({
					workspaceId: 'ws-1',
					agent: { id: '' },
					content: 'hi',
				})
			}),
		).rejects.toThrow('No agent selected')
		expect(api.sessions.create).not.toHaveBeenCalled()
	})

	it('clear() resets events, status, and sessionId', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue(buildSession('sess-z'))

		const { result } = renderHook(() => useSindreOneShot(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.send({
				workspaceId: 'ws-1',
				agent: { id: 'actor-reviewer' },
				content: 'hi',
			})
		})

		act(() =>
			lastFesInit?.onmessage({
				event: 'stdout',
				data: JSON.stringify({
					type: 'assistant',
					session_id: 'sess-z',
					message: { id: 'm', content: [{ type: 'text', text: 'hi' }] },
				}),
			}),
		)

		expect(result.current.events.length).toBeGreaterThan(0)

		act(() => result.current.clear())

		expect(result.current.events).toEqual([])
		expect(result.current.sessionId).toBeNull()
		expect(result.current.status).toBe('idle')
		expect(result.current.error).toBeNull()
	})
})
