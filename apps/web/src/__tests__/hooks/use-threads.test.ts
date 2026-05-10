import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		threads: {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			postEvent: vi.fn(),
			addParticipant: vi.fn(),
			removeParticipant: vi.fn(),
		},
	},
}))

import {
	useCreateThread,
	usePostThreadEvent,
	useRemoveThreadParticipant,
	useResolveThread,
	useThread,
	useThreads,
} from '@/hooks/use-threads'
import type { ThreadEventResponse, ThreadResponse, ThreadWithEvents } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const threadId = 'thread-1'

function buildThread(overrides: Partial<ThreadResponse> = {}): ThreadResponse {
	return {
		id: threadId,
		workspaceId,
		focusObjectId: null,
		visibility: 'channel',
		state: 'open',
		kind: 'discussion',
		title: 'Test Thread',
		createdBy: 'actor-1',
		createdAt: '2024-01-01T00:00:00Z',
		updatedAt: '2024-01-01T00:00:00Z',
		...overrides,
	}
}

function buildThreadWithEvents(overrides: Partial<ThreadWithEvents> = {}): ThreadWithEvents {
	return {
		...buildThread(),
		events: [],
		...overrides,
	}
}

function buildThreadEvent(overrides: Partial<ThreadEventResponse> = {}): ThreadEventResponse {
	return {
		id: 'event-1',
		threadId,
		actorId: 'actor-1',
		kind: 'message',
		body: 'Hello world',
		createdAt: '2024-01-01T00:00:00Z',
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useThreads', () => {
	it('fetches thread list for workspace', async () => {
		const threads = [buildThread({ id: 'thread-1' }), buildThread({ id: 'thread-2' })]
		vi.mocked(api.threads.list).mockResolvedValue(threads)

		const { result } = renderHook(() => useThreads(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(threads)
		expect(api.threads.list).toHaveBeenCalledWith(workspaceId, undefined)
	})

	it('passes filters to API', async () => {
		vi.mocked(api.threads.list).mockResolvedValue([])

		const { result } = renderHook(() => useThreads(workspaceId, { state: 'open' }), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.threads.list).toHaveBeenCalledWith(workspaceId, { state: 'open' })
	})

	it('is disabled when workspaceId is empty', () => {
		const { result } = renderHook(() => useThreads(''), { wrapper: TestWrapper })

		expect(result.current.isFetching).toBe(false)
		expect(api.threads.list).not.toHaveBeenCalled()
	})
})

describe('useThread', () => {
	it('fetches single thread detail', async () => {
		const thread = buildThreadWithEvents({ events: [buildThreadEvent()] })
		vi.mocked(api.threads.get).mockResolvedValue(thread)

		const { result } = renderHook(() => useThread(workspaceId, threadId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(thread)
		expect(api.threads.get).toHaveBeenCalledWith(threadId, workspaceId)
	})

	it('is disabled when threadId is null', () => {
		const { result } = renderHook(() => useThread(workspaceId, null), { wrapper: TestWrapper })

		expect(result.current.isFetching).toBe(false)
		expect(api.threads.get).not.toHaveBeenCalled()
	})
})

describe('useCreateThread', () => {
	it('calls API and returns new thread', async () => {
		const thread = buildThread({ title: 'New Thread' })
		vi.mocked(api.threads.create).mockResolvedValue(thread)

		const { result } = renderHook(() => useCreateThread(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ title: 'New Thread', visibility: 'channel' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.threads.create).toHaveBeenCalledWith(workspaceId, {
			title: 'New Thread',
			visibility: 'channel',
		})
		expect(result.current.data).toEqual(thread)
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.threads.create).mockRejectedValue(new Error('Validation failed'))

		const { result } = renderHook(() => useCreateThread(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ title: '', visibility: 'channel' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Validation failed')
	})
})

describe('usePostThreadEvent', () => {
	it('calls API with event data', async () => {
		const event = buildThreadEvent()
		vi.mocked(api.threads.postEvent).mockResolvedValue(event)

		const { result } = renderHook(() => usePostThreadEvent(workspaceId, threadId), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ kind: 'message', body: 'Hello world' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.threads.postEvent).toHaveBeenCalledWith(threadId, workspaceId, {
			kind: 'message',
			body: 'Hello world',
		})
	})
})

describe('useResolveThread', () => {
	it('calls update with resolved state', async () => {
		const thread = buildThread({ state: 'resolved' })
		vi.mocked(api.threads.update).mockResolvedValue(thread)

		const { result } = renderHook(() => useResolveThread(workspaceId, threadId), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ state: 'resolved' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.threads.update).toHaveBeenCalledWith(threadId, workspaceId, { state: 'resolved' })
	})
})

describe('useRemoveThreadParticipant', () => {
	it('calls removeParticipant API with actorId', async () => {
		vi.mocked(api.threads.removeParticipant).mockResolvedValue({ ok: true })

		const { result } = renderHook(() => useRemoveThreadParticipant(workspaceId, threadId), {
			wrapper: TestWrapper,
		})

		result.current.mutate('actor-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.threads.removeParticipant).toHaveBeenCalledWith(threadId, workspaceId, 'actor-1')
	})

	it('exposes error when remove fails', async () => {
		vi.mocked(api.threads.removeParticipant).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useRemoveThreadParticipant(workspaceId, threadId), {
			wrapper: TestWrapper,
		})

		result.current.mutate('actor-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})
})
