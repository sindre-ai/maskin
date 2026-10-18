import { useQueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		workspaces: { deletionPreview: vi.fn(), delete: vi.fn() },
	},
}))

import { useDeleteWorkspace, useWorkspaceDeletionPreview } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { TestWrapper } from '../setup'

beforeEach(() => vi.clearAllMocks())

describe('useWorkspaceDeletionPreview', () => {
	it('does not fetch until enabled', () => {
		renderHook(() => useWorkspaceDeletionPreview('ws-1', false), { wrapper: TestWrapper })
		expect(api.workspaces.deletionPreview).not.toHaveBeenCalled()
	})

	it('returns blockers from the server', async () => {
		const preview = {
			workspace_id: 'ws-1',
			workspace_name: 'Acme',
			can_delete: false,
			blockers: [{ code: 'cancel_plan' as const, message: 'Cancel the plan first.' }],
			other_members: 2,
		}
		vi.mocked(api.workspaces.deletionPreview).mockResolvedValue(preview)
		const { result } = renderHook(() => useWorkspaceDeletionPreview('ws-1', true), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.blockers[0].code).toBe('cancel_plan')
	})
})

describe('useDeleteWorkspace', () => {
	it('sends the typed confirmation name', async () => {
		vi.mocked(api.workspaces.delete).mockResolvedValue({ deleted: true })
		const { result } = renderHook(() => useDeleteWorkspace('ws-1'), { wrapper: TestWrapper })
		result.current.mutate('Acme')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.workspaces.delete).toHaveBeenCalledWith('ws-1', 'Acme')
	})

	it('keeps the workspace caches when cleanup is deferred', async () => {
		vi.mocked(api.workspaces.delete).mockResolvedValue({ deleted: true })
		const { result } = renderHook(
			() => ({
				del: useDeleteWorkspace('ws-1', { deferCleanup: true }),
				qc: useQueryClient(),
			}),
			{ wrapper: TestWrapper },
		)
		const remove = vi.spyOn(result.current.qc, 'removeQueries')
		result.current.del.mutate('Acme')
		await waitFor(() => expect(result.current.del.isSuccess).toBe(true))
		expect(remove).not.toHaveBeenCalled()
	})

	it('drops the workspace caches on success by default', async () => {
		vi.mocked(api.workspaces.delete).mockResolvedValue({ deleted: true })
		const { result } = renderHook(
			() => ({ del: useDeleteWorkspace('ws-1'), qc: useQueryClient() }),
			{ wrapper: TestWrapper },
		)
		const remove = vi.spyOn(result.current.qc, 'removeQueries')
		result.current.del.mutate('Acme')
		await waitFor(() => expect(result.current.del.isSuccess).toBe(true))
		expect(remove).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.detail('ws-1') })
	})
})
