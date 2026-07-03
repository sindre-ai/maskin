import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
			get: vi.fn(),
			graph: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			bulkUpdate: vi.fn(),
		},
	},
}))

// Suppress toast in tests
vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import {
	useBulkUpdateObjects,
	useCreateObject,
	useDeleteObject,
	useObject,
	useObjectGraph,
	useObjects,
	useUpdateObject,
} from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildObject(overrides: Partial<ObjectResponse> & { id: string }): ObjectResponse {
	return {
		workspaceId: 'ws-1',
		type: 'task',
		title: null,
		content: null,
		status: 'todo',
		metadata: null,
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useObjects', () => {
	it('exposes error when API rejects', async () => {
		vi.mocked(api.objects.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useObjects(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})

	it('fetches objects for workspace', async () => {
		const mockObjects = [
			buildObject({ id: 'obj-1', title: 'Task 1', type: 'task' }),
			buildObject({ id: 'obj-2', title: 'Bet 1', type: 'bet' }),
		]
		vi.mocked(api.objects.list).mockResolvedValue(mockObjects)

		const { result } = renderHook(() => useObjects(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockObjects)
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, undefined)
	})

	it('passes filters to API call', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([])
		const filters = { type: 'task', status: 'todo' }

		const { result } = renderHook(() => useObjects(workspaceId, filters), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, filters)
	})
})

describe('useObject', () => {
	it('fetches single object by id', async () => {
		const mockObject = buildObject({ id: 'obj-2', title: 'Bet 1', type: 'bet' })
		vi.mocked(api.objects.get).mockResolvedValue(mockObject)

		const { result } = renderHook(() => useObject('obj-2'), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.id).toBe('obj-2')
		expect(api.objects.get).toHaveBeenCalledWith('obj-2')
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.objects.get).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useObject('nonexistent'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})
})

describe('useObjectGraph', () => {
	it('fetches graph (object + relationships + connected_objects + events) for an id', async () => {
		const obj = buildObject({ id: 'bet-1', type: 'bet' })
		const linkedTask = buildObject({ id: 'task-1', type: 'task' })
		const graph = {
			object: obj,
			relationships: [
				{
					id: 'rel-1',
					sourceType: 'object',
					sourceId: 'task-1',
					targetType: 'object',
					targetId: 'bet-1',
					type: 'breaks_into',
					createdBy: 'actor-1',
					createdAt: null,
				},
			],
			connected_objects: [linkedTask],
			events: [],
			files: [],
		}
		vi.mocked(api.objects.graph).mockResolvedValue(graph)

		const { result } = renderHook(() => useObjectGraph(workspaceId, 'bet-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(graph)
		expect(api.objects.graph).toHaveBeenCalledWith('bet-1', workspaceId)
	})

	it('is disabled when id is empty', () => {
		const { result } = renderHook(() => useObjectGraph(workspaceId, ''), { wrapper: TestWrapper })
		expect(result.current.isFetching).toBe(false)
		expect(api.objects.graph).not.toHaveBeenCalled()
	})
})

describe('useCreateObject', () => {
	it('exposes error when create fails', async () => {
		vi.mocked(api.objects.create).mockRejectedValue(new Error('Validation failed'))

		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'task', title: 'Bad', status: 'todo' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Validation failed')
	})

	it('calls api.objects.create with workspace and data', async () => {
		const newObject = buildObject({ id: 'obj-new', title: 'New', type: 'task', status: 'todo' })
		vi.mocked(api.objects.create).mockResolvedValue(newObject)

		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'task', title: 'New', status: 'todo' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.create).toHaveBeenCalledWith(workspaceId, {
			type: 'task',
			title: 'New',
			status: 'todo',
		})
	})
})

describe('useUpdateObject', () => {
	it('exposes error when update fails', async () => {
		vi.mocked(api.objects.update).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'obj-1', data: { title: 'Nope' } })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})

	it('calls api.objects.update with id and data', async () => {
		vi.mocked(api.objects.update).mockResolvedValue(buildObject({ id: 'obj-1', title: 'Updated' }))

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'obj-1', data: { title: 'Updated' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.update).toHaveBeenCalledWith('obj-1', { title: 'Updated' })
	})
})

describe('useBulkUpdateObjects', () => {
	function makeWrapper() {
		// Use a client with non-zero gcTime so cache entries we seed via
		// setQueryData survive long enough for the mutation's onMutate to read
		// them (the shared createTestQueryClient uses gcTime: 0).
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: 1000 * 60 },
				mutations: { retry: false },
			},
		})
		const Wrapper = ({ children }: { children: ReactNode }) =>
			React.createElement(QueryClientProvider, { client: queryClient }, children)
		return { queryClient, Wrapper }
	}

	it('calls api.objects.bulkUpdate with workspace + body and returns per-id results', async () => {
		const response = {
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: false, error: "Invalid status 'done' for type 'bet'" },
			],
		}
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue(response)
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })

		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'done' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.bulkUpdate).toHaveBeenCalledWith(workspaceId, {
			ids: ['obj-1', 'obj-2'],
			patch: { status: 'done' },
		})
		expect(result.current.data).toEqual(response)
	})

	it('optimistically patches infinite-query cache before the request resolves', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		const seed = (status: string) => [
			buildObject({ id: 'obj-1', status, type: 'task' }),
			buildObject({ id: 'obj-2', status, type: 'task' }),
			buildObject({ id: 'obj-3', status, type: 'task' }),
		]
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, { pages: [seed('todo')], pageParams: [0] })

		let resolve!: (value: { results: Array<{ id: string; ok: boolean }> }) => void
		vi.mocked(api.objects.bulkUpdate).mockReturnValue(
			new Promise((res) => {
				resolve = res
			}),
		)

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'in_progress' } })

		// Before the request resolves, the cache should already reflect the patch
		// for selected ids and leave un-selected rows untouched.
		await waitFor(() => {
			const cache = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)
			const rows = cache?.pages[0] ?? []
			expect(rows.find((r) => r.id === 'obj-1')?.status).toBe('in_progress')
			expect(rows.find((r) => r.id === 'obj-2')?.status).toBe('in_progress')
			expect(rows.find((r) => r.id === 'obj-3')?.status).toBe('todo')
		})

		resolve({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: true },
			],
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
	})

	it('rolls the cache back when the request rejects', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		const seed = [
			buildObject({ id: 'obj-1', status: 'todo', type: 'task' }),
			buildObject({ id: 'obj-2', status: 'todo', type: 'task' }),
		]
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, { pages: [seed], pageParams: [0] })

		vi.mocked(api.objects.bulkUpdate).mockRejectedValue(new Error('Network'))
		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'done' } })

		await waitFor(() => expect(result.current.isError).toBe(true))
		const cache = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)
		const rows = cache?.pages[0] ?? []
		expect(rows.every((r) => r.status === 'todo')).toBe(true)
	})
})

describe('useDeleteObject', () => {
	it('exposes error when delete fails', async () => {
		vi.mocked(api.objects.delete).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('obj-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})

	it('calls api.objects.delete with id', async () => {
		vi.mocked(api.objects.delete).mockResolvedValue({ deleted: true })

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('obj-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.delete).toHaveBeenCalledWith('obj-1')
	})
})
