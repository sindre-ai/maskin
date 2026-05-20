import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			get: vi.fn(),
			list: vi.fn(),
			logs: vi.fn(),
			create: vi.fn(),
		},
	},
}))

import {
	useActiveSessionsForActor,
	useActorSessionsInfinite,
	useCreateSession,
	useMentionSessionsForObject,
	useSession,
	useSessionErrorLog,
	useWorkspaceSessions,
} from '@/hooks/use-sessions'
import type { SessionLogResponse, SessionResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildSession(overrides: Partial<SessionResponse> & { id: string }): SessionResponse {
	return {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Do something',
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: null,
		completedAt: null,
		timeoutAt: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function buildLog(overrides: Partial<SessionLogResponse> & { id: number }): SessionLogResponse {
	return {
		sessionId: 'session-1',
		stream: 'stdout',
		content: 'log line',
		createdAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useSession', () => {
	it('fetches session by id', async () => {
		const mockSession = buildSession({ id: 'session-1' })
		vi.mocked(api.sessions.get).mockResolvedValue(mockSession)

		const { result } = renderHook(() => useSession('session-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockSession)
		expect(api.sessions.get).toHaveBeenCalledWith('session-1', workspaceId)
	})

	it('is not enabled when id is null', async () => {
		const { result } = renderHook(() => useSession(null, workspaceId), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.get).not.toHaveBeenCalled()
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.sessions.get).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useSession('session-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})
})

describe('useWorkspaceSessions', () => {
	it('fetches sessions for workspace', async () => {
		const mockSessions = [buildSession({ id: 'session-1' }), buildSession({ id: 'session-2' })]
		vi.mocked(api.sessions.list).mockResolvedValue(mockSessions)

		const { result } = renderHook(() => useWorkspaceSessions(workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockSessions)
		expect(api.sessions.list).toHaveBeenCalledWith(workspaceId, { limit: '100' })
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.sessions.list).mockRejectedValue(new Error('Server error'))

		const { result } = renderHook(() => useWorkspaceSessions(workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Server error')
	})
})

describe('useCreateSession', () => {
	it('calls api.sessions.create with workspace and data', async () => {
		const newSession = buildSession({ id: 'session-new' })
		vi.mocked(api.sessions.create).mockResolvedValue(newSession)

		const { result } = renderHook(() => useCreateSession(workspaceId), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ actor_id: 'actor-1', action_prompt: 'Run task' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.sessions.create).toHaveBeenCalledWith(workspaceId, {
			actor_id: 'actor-1',
			action_prompt: 'Run task',
		})
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.sessions.create).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useCreateSession(workspaceId), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ actor_id: 'actor-1', action_prompt: 'Bad' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})
})

describe('useActiveSessionsForActor', () => {
	it('fetches active sessions for actor', async () => {
		const mockSessions = [buildSession({ id: 'session-1', status: 'running' })]
		vi.mocked(api.sessions.list).mockResolvedValue(mockSessions)

		const { result } = renderHook(() => useActiveSessionsForActor('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockSessions)
		expect(api.sessions.list).toHaveBeenCalledWith(workspaceId, {
			actor_id: 'actor-1',
			status: 'running',
		})
	})

	it('is not enabled when actorId is empty', async () => {
		const { result } = renderHook(() => useActiveSessionsForActor('', workspaceId), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.list).not.toHaveBeenCalled()
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.sessions.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useActiveSessionsForActor('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useMentionSessionsForObject', () => {
	it('fetches sessions filtered by mention_object_id', async () => {
		const sessions = [buildSession({ id: 'session-mention-1' })]
		vi.mocked(api.sessions.list).mockResolvedValue(sessions)

		const { result } = renderHook(() => useMentionSessionsForObject(workspaceId, 'object-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(sessions)
		expect(api.sessions.list).toHaveBeenCalledWith(workspaceId, {
			mention_object_id: 'object-1',
			limit: '100',
		})
	})

	it('is not enabled when objectId is null', async () => {
		const { result } = renderHook(() => useMentionSessionsForObject(workspaceId, null), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.list).not.toHaveBeenCalled()
	})
})

describe('useSessionErrorLog', () => {
	it('returns joined stderr content', async () => {
		const logs = [
			buildLog({ id: 1, stream: 'stderr', content: 'Error line 1' }),
			buildLog({ id: 2, stream: 'stderr', content: 'Error line 2' }),
		]
		vi.mocked(api.sessions.logs).mockResolvedValue(logs)

		const { result } = renderHook(() => useSessionErrorLog('session-1', workspaceId, true), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBe('Error line 1\nError line 2')
		expect(api.sessions.logs).toHaveBeenCalledWith('session-1', workspaceId, {
			limit: '5',
			stream: 'stderr',
		})
	})

	it('returns null when no stderr logs', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])

		const { result } = renderHook(() => useSessionErrorLog('session-1', workspaceId, true), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})

	it('is not enabled when sessionId is null', async () => {
		const { result } = renderHook(() => useSessionErrorLog(null, workspaceId, true), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.logs).not.toHaveBeenCalled()
	})

	it('is not enabled when enabled flag is false', async () => {
		const { result } = renderHook(() => useSessionErrorLog('session-1', workspaceId, false), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.logs).not.toHaveBeenCalled()
	})
})

describe('useActorSessionsInfinite', () => {
	it('fetches the first page with offset 0 and PAGE_SIZE limit', async () => {
		const mockSessions = Array.from({ length: 5 }, (_, i) =>
			buildSession({ id: `session-${i}`, actorId: 'actor-1' }),
		)
		vi.mocked(api.sessions.list).mockResolvedValue(mockSessions)

		const { result } = renderHook(() => useActorSessionsInfinite('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.pages.flat()).toEqual(mockSessions)
		expect(api.sessions.list).toHaveBeenCalledWith(workspaceId, {
			actor_id: 'actor-1',
			limit: '5',
			offset: '0',
		})
		expect(result.current.hasNextPage).toBe(true)
	})

	it('appends the next page when fetchNextPage is called', async () => {
		const page1 = Array.from({ length: 5 }, (_, i) =>
			buildSession({ id: `s1-${i}`, actorId: 'actor-1' }),
		)
		const page2 = Array.from({ length: 5 }, (_, i) =>
			buildSession({ id: `s2-${i}`, actorId: 'actor-1' }),
		)
		vi.mocked(api.sessions.list).mockImplementation(async (_ws, params) =>
			params?.offset === '0' ? page1 : page2,
		)

		const { result } = renderHook(() => useActorSessionsInfinite('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.pages).toHaveLength(1)

		await act(async () => {
			await result.current.fetchNextPage()
		})

		await waitFor(() => expect(result.current.data?.pages.flat()).toHaveLength(10))
		expect(api.sessions.list).toHaveBeenLastCalledWith(workspaceId, {
			actor_id: 'actor-1',
			limit: '5',
			offset: '5',
		})
	})

	it('reports no next page once a short page is returned', async () => {
		vi.mocked(api.sessions.list).mockResolvedValue([
			buildSession({ id: 'only', actorId: 'actor-1' }),
		])

		const { result } = renderHook(() => useActorSessionsInfinite('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.hasNextPage).toBe(false)
	})

	it('is not enabled when actorId is empty', async () => {
		const { result } = renderHook(() => useActorSessionsInfinite('', workspaceId), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.sessions.list).not.toHaveBeenCalled()
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.sessions.list).mockRejectedValue(new Error('Server error'))

		const { result } = renderHook(() => useActorSessionsInfinite('actor-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Server error')
	})
})
