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

	it('does not fetch when enabled is false', () => {
		const { result } = renderHook(() => useObject('obj-3', { enabled: false }), {
			wrapper: TestWrapper,
		})

		expect(result.current.fetchStatus).toBe('idle')
		expect(api.objects.get).not.toHaveBeenCalled()
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

	// AC-T1: with 2 ≤ N ≤ 200 selected ids, exactly one POST /bulk-update fires
	// carrying all ids + the patch — not N per-object PATCH calls. Verifies the
	// wire shape at both ends of the range.
	it('fires exactly one bulkUpdate call for N=2 and again for N=200', async () => {
		const { Wrapper } = makeWrapper()
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({ results: [] })
		vi.mocked(api.objects.update).mockResolvedValue(buildObject({ id: 'unused' }))

		for (const size of [2, 200]) {
			vi.mocked(api.objects.bulkUpdate).mockClear()
			vi.mocked(api.objects.update).mockClear()
			const ids = Array.from({ length: size }, (_, i) => `obj-${i}`)
			vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
				results: ids.map((id) => ({ id, ok: true })),
			})
			const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
			result.current.mutate({ ids, patch: { status: 'done' } })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.objects.bulkUpdate).toHaveBeenCalledTimes(1)
			expect(api.objects.bulkUpdate).toHaveBeenCalledWith(workspaceId, {
				ids,
				patch: { status: 'done' },
			})
			// The wire must not fall back to per-id PATCH calls.
			expect(api.objects.update).not.toHaveBeenCalled()
		}
	})

	// AC-T2: the optimistic patch must land on the flat list cache too, not just
	// the infinite-query cache — the objects page uses infinite lists but other
	// callers (board view, related-objects tables) read from the flat list slice.
	it('optimistically patches the flat list cache slice', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		const key = queryKeys.objects.list(workspaceId, { type: 'task' })
		queryClient.setQueryData(key, [
			buildObject({ id: 'obj-1', status: 'todo', type: 'task' }),
			buildObject({ id: 'obj-2', status: 'todo', type: 'task' }),
			buildObject({ id: 'obj-3', status: 'todo', type: 'task' }),
		])

		let resolve!: (value: { results: Array<{ id: string; ok: boolean }> }) => void
		vi.mocked(api.objects.bulkUpdate).mockReturnValue(
			new Promise((res) => {
				resolve = res
			}),
		)

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'in_progress' } })

		await waitFor(() => {
			const rows = queryClient.getQueryData<ObjectResponse[]>(key) ?? []
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

	// AC-T2: per-id detail caches (open detail pages) must reflect the patch
	// immediately so a detail view sitting behind the objects list doesn't lag.
	it('optimistically patches per-id detail caches for seeded ids only', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		// obj-1 has an open detail cache; obj-2 does not. onMutate must patch
		// only obj-1 and leave obj-2 alone — otherwise we'd fabricate a detail
		// entry the user never opened.
		queryClient.setQueryData(
			queryKeys.objects.detail('obj-1'),
			buildObject({ id: 'obj-1', status: 'todo', type: 'task' }),
		)

		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: true },
			],
		})

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'done' } })

		await waitFor(() => {
			const seeded = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail('obj-1'))
			expect(seeded?.status).toBe('done')
		})
		// Unseeded detail cache stays undefined — no fabricated entry.
		expect(queryClient.getQueryData(queryKeys.objects.detail('obj-2'))).toBeUndefined()
	})

	// AC-T3: rollback restores every snapshot on reject — including the
	// per-id detail snapshot. A seeded detail cache must return to its pre-
	// mutation status when the promise rejects.
	it('rollback restores per-id detail cache on reject', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		queryClient.setQueryData(
			queryKeys.objects.detail('obj-1'),
			buildObject({ id: 'obj-1', status: 'todo', type: 'task' }),
		)
		vi.mocked(api.objects.bulkUpdate).mockRejectedValue(new Error('Network'))

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1'], patch: { status: 'done' } })

		await waitFor(() => expect(result.current.isError).toBe(true))
		const cached = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail('obj-1'))
		expect(cached?.status).toBe('todo')
	})

	// onSettled: after a partial-failure response, list caches are invalidated
	// (so a refetch reconciles the failed rows) and per-id detail caches are
	// invalidated only for ok ids — failed ids stay optimistically patched only
	// long enough for the caller to trim selection and let the list refetch
	// deliver the real state. This locks the wire contract behind AC-T4.
	it('invalidates only ok-id detail caches on partial-failure response', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: false, error: 'nope' },
			],
		})

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'done' } })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		const detailInvalidations = invalidateSpy.mock.calls
			.map(([opts]) => opts?.queryKey)
			.filter(
				(k): k is readonly unknown[] => Array.isArray(k) && k[0] === 'objects' && k[1] === 'detail',
			)
		expect(detailInvalidations.some((k) => k[2] === 'obj-1')).toBe(true)
		expect(detailInvalidations.some((k) => k[2] === 'obj-2')).toBe(false)
	})

	// On a network failure (no data), onSettled falls back to invalidating every
	// requested id's detail cache — since we don't know which rows actually
	// changed server-side.
	it('invalidates every requested detail cache on network failure', async () => {
		const { queryClient, Wrapper } = makeWrapper()
		const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
		vi.mocked(api.objects.bulkUpdate).mockRejectedValue(new Error('Network'))

		const { result } = renderHook(() => useBulkUpdateObjects(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ ids: ['obj-1', 'obj-2'], patch: { status: 'done' } })

		await waitFor(() => expect(result.current.isError).toBe(true))
		const detailInvalidations = invalidateSpy.mock.calls
			.map(([opts]) => opts?.queryKey)
			.filter(
				(k): k is readonly unknown[] => Array.isArray(k) && k[0] === 'objects' && k[1] === 'detail',
			)
		expect(detailInvalidations.some((k) => k[2] === 'obj-1')).toBe(true)
		expect(detailInvalidations.some((k) => k[2] === 'obj-2')).toBe(true)
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
