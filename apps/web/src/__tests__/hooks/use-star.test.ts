import { useStar } from '@/hooks/use-star'
import type { ObjectResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../factories'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/api', () => ({
	api: { objects: { star: vi.fn(), unstar: vi.fn() } },
}))

import { api } from '@/lib/api'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const OBJECT_ID = '00000000-0000-4000-8000-000000000abc'

function wrapper(queryClient: QueryClient) {
	const workspace = buildWorkspaceWithRole({ id: WORKSPACE_ID })
	const ctx: WorkspaceContextValue = {
		workspace,
		workspaceId: WORKSPACE_ID,
		sseStatus: 'connected',
	}
	return ({ children }: { children: ReactNode }) =>
		React.createElement(
			QueryClientProvider,
			{ client: queryClient },
			React.createElement(WorkspaceContext.Provider, { value: ctx }, children),
		)
}

function makeObject(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return {
		id: OBJECT_ID,
		workspaceId: WORKSPACE_ID,
		type: 'task',
		title: 'Ship the thing',
		content: null,
		status: 'todo',
		metadata: null,
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		is_starred_by_me: false,
		...overrides,
	}
}

describe('useStar', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('reads is_starred_by_me off the detail cache', () => {
		const qc = new QueryClient()
		qc.setQueryData(queryKeys.objects.detail(OBJECT_ID), makeObject({ is_starred_by_me: true }))
		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })
		expect(result.current.isStarred).toBe(true)
	})

	it('falls back to the list cache when the detail cache is absent', () => {
		const qc = new QueryClient()
		qc.setQueryData(queryKeys.objects.list(WORKSPACE_ID, undefined), [
			makeObject({ is_starred_by_me: true }),
		])
		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })
		expect(result.current.isStarred).toBe(true)
	})

	it('defaults to false when no cache carries the object', () => {
		const qc = new QueryClient()
		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })
		expect(result.current.isStarred).toBe(false)
	})

	it('optimistically flips the detail cache and calls POST /star', async () => {
		const qc = new QueryClient()
		qc.setQueryData(queryKeys.objects.detail(OBJECT_ID), makeObject({ is_starred_by_me: false }))
		vi.mocked(api.objects.star).mockResolvedValue({
			is_starred_by_me: true,
			starred_at: '2026-09-14T00:00:00Z',
		})
		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })

		act(() => result.current.toggle())
		// Optimistic patch lands synchronously in TanStack Query's onMutate.
		const detail = qc.getQueryData<ObjectResponse>(queryKeys.objects.detail(OBJECT_ID))
		expect(detail?.is_starred_by_me).toBe(true)
		// The mutation itself runs on the next microtask, so wait for the spy.
		await waitFor(() =>
			expect(api.objects.star).toHaveBeenCalledWith(OBJECT_ID, WORKSPACE_ID),
		)
		await waitFor(() => expect(result.current.isSaving).toBe(false))
	})

	it('reverts the optimistic patch and toasts on error', async () => {
		const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
		qc.setQueryData(queryKeys.objects.detail(OBJECT_ID), makeObject({ is_starred_by_me: false }))
		vi.mocked(api.objects.star).mockRejectedValue(new Error('boom'))
		const { toast } = await import('sonner')

		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })
		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.isSaving).toBe(false))

		// The failed toggle reverted to the pre-mutation state (unstarred), and
		// the toast surfaced the SPEC-mandated copy.
		const detail = qc.getQueryData<ObjectResponse>(queryKeys.objects.detail(OBJECT_ID))
		expect(detail?.is_starred_by_me).toBe(false)
		expect(toast.error).toHaveBeenCalledWith("Couldn't update. Try again.")
	})

	it('optimistically patches the flat list cache, not just detail', async () => {
		const qc = new QueryClient()
		qc.setQueryData(queryKeys.objects.list(WORKSPACE_ID, undefined), [
			makeObject({ is_starred_by_me: false }),
		])
		vi.mocked(api.objects.star).mockResolvedValue({
			is_starred_by_me: true,
			starred_at: '2026-09-14T00:00:00Z',
		})

		const { result } = renderHook(() => useStar(OBJECT_ID), { wrapper: wrapper(qc) })
		act(() => result.current.toggle())
		const list = qc.getQueryData<ObjectResponse[]>(queryKeys.objects.list(WORKSPACE_ID, undefined))
		expect(list?.[0]?.is_starred_by_me).toBe(true)
	})
})
