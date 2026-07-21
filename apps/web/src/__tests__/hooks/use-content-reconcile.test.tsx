import { useContentReconcile } from '@/hooks/use-content-reconcile'
import { ApiError, type ObjectResponse, api } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../factories'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			objects: {
				...actual.api.objects,
				update: vi.fn(),
			},
		},
	}
})

function wrapperWith(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	)
}

function buildTheirs(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return buildObjectResponse({
		id: 'obj-1',
		content: 'server text',
		version: 5,
		...overrides,
	})
}

describe('useContentReconcile', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('routes success through the mutation without opening the banner', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'client text', version: 3 })
		const updated = buildObjectResponse({ id: 'obj-1', content: 'client text v2', version: 4 })
		vi.mocked(api.objects.update).mockResolvedValue(updated)

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => {
			result.current.saveContent('client text v2')
		})

		await waitFor(() => {
			expect(api.objects.update).toHaveBeenCalledWith('obj-1', {
				content: 'client text v2',
				version: 3,
			})
		})
		expect(result.current.status).toBe('idle')
		expect(result.current.conflict).toBeNull()
	})

	it('surfaces the banner and fires onConflictDetected on 409', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirs = buildTheirs({ content: 'theirs', version: 5 })
		vi.mocked(api.objects.update).mockRejectedValue(
			new ApiError(409, 'stale', undefined, { object: theirs }),
		)
		const onConflictDetected = vi.fn()

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object, onConflictDetected }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => {
			result.current.saveContent('new draft')
		})

		await waitFor(() => expect(result.current.status).toBe('conflict'))
		expect(result.current.conflict?.mine).toBe('new draft')
		expect(result.current.conflict?.theirs).toBe('theirs')
		expect(result.current.conflict?.freshVersion).toBe(5)
		expect(onConflictDetected).toHaveBeenCalledWith(
			expect.objectContaining({ objectId: 'obj-1', staleVersion: 3, freshVersion: 5 }),
		)
	})

	it('keep-mine re-PATCHes with the fresh version and resolves', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirs = buildTheirs({ content: 'theirs', version: 5 })
		const resolved = buildObjectResponse({ id: 'obj-1', content: 'new draft', version: 6 })
		vi.mocked(api.objects.update)
			.mockRejectedValueOnce(new ApiError(409, 'stale', undefined, { object: theirs }))
			.mockResolvedValueOnce(resolved)
		const onConflictResolved = vi.fn()

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object, onConflictResolved }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => {
			result.current.saveContent('new draft')
		})
		await waitFor(() => expect(result.current.status).toBe('conflict'))

		await act(async () => {
			await result.current.keepMine()
		})

		expect(api.objects.update).toHaveBeenLastCalledWith('obj-1', {
			content: 'new draft',
			version: 5,
		})
		expect(result.current.status).toBe('idle')
		expect(result.current.conflict).toBeNull()
		expect(onConflictResolved).toHaveBeenCalledWith(
			expect.objectContaining({ resolution: 'keep_mine', freshVersion: 5 }),
		)
	})

	it('keep-mine on a second 409 keeps the banner up with the newer theirs', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirsA = buildTheirs({ content: 'theirs v5', version: 5 })
		const theirsB = buildTheirs({ content: 'theirs v6', version: 6 })
		vi.mocked(api.objects.update)
			.mockRejectedValueOnce(new ApiError(409, 'stale', undefined, { object: theirsA }))
			.mockRejectedValueOnce(new ApiError(409, 'stale', undefined, { object: theirsB }))

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => result.current.saveContent('new draft'))
		await waitFor(() => expect(result.current.status).toBe('conflict'))

		await act(async () => {
			await result.current.keepMine()
		})

		expect(result.current.status).toBe('conflict')
		expect(result.current.conflict?.freshVersion).toBe(6)
		expect(result.current.conflict?.theirs).toBe('theirs v6')
	})

	it('take-theirs writes theirs to the cache after confirm and emits resolved', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirs = buildTheirs({ content: 'theirs', version: 5 })
		vi.mocked(api.objects.update).mockRejectedValue(
			new ApiError(409, 'stale', undefined, { object: theirs }),
		)
		const onConflictResolved = vi.fn()

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object, onConflictResolved }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => result.current.saveContent('new draft'))
		await waitFor(() => expect(result.current.status).toBe('conflict'))

		act(() => result.current.requestTakeTheirs())
		expect(result.current.status).toBe('confirming_take_theirs')

		act(() => result.current.confirmTakeTheirs())

		expect(result.current.status).toBe('idle')
		expect(result.current.conflict).toBeNull()
		expect(queryClient.getQueryData(['objects', 'detail', 'obj-1'])).toEqual(theirs)
		expect(onConflictResolved).toHaveBeenCalledWith(
			expect.objectContaining({ resolution: 'take_theirs' }),
		)
	})

	it('review opens and closes without dismissing the banner', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirs = buildTheirs()
		vi.mocked(api.objects.update).mockRejectedValue(
			new ApiError(409, 'stale', undefined, { object: theirs }),
		)

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => result.current.saveContent('draft'))
		await waitFor(() => expect(result.current.status).toBe('conflict'))

		act(() => result.current.openReview())
		expect(result.current.status).toBe('reviewing')
		act(() => result.current.closeReview())
		expect(result.current.status).toBe('conflict')
		expect(result.current.conflict).not.toBeNull()
	})

	it('drops writes while a conflict is active (no silent clobber)', async () => {
		const object = buildObjectResponse({ id: 'obj-1', content: 'mine', version: 3 })
		const theirs = buildTheirs()
		vi.mocked(api.objects.update).mockRejectedValue(
			new ApiError(409, 'stale', undefined, { object: theirs }),
		)

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const { result } = renderHook(() => useContentReconcile({ object }), {
			wrapper: wrapperWith(queryClient),
		})

		act(() => result.current.saveContent('draft'))
		await waitFor(() => expect(result.current.status).toBe('conflict'))

		vi.mocked(api.objects.update).mockClear()
		act(() => result.current.saveContent('more typing'))
		expect(api.objects.update).not.toHaveBeenCalled()
	})
})
