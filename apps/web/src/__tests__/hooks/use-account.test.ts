import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		account: { deletionPreview: vi.fn(), delete: vi.fn() },
	},
}))

import { useAccountDeletionPreview, useDeleteAccount } from '@/hooks/use-account'
import { api } from '@/lib/api'
import { getApiKey, setApiKey } from '@/lib/auth'
import { TestWrapper } from '../setup'

beforeEach(() => {
	vi.clearAllMocks()
	localStorage.clear()
})

describe('useAccountDeletionPreview', () => {
	it('does not fetch until enabled', () => {
		renderHook(() => useAccountDeletionPreview(false), { wrapper: TestWrapper })
		expect(api.account.deletionPreview).not.toHaveBeenCalled()
	})

	it('returns the preview once enabled', async () => {
		const preview = { can_delete: true, blockers: [], leaving: [] }
		vi.mocked(api.account.deletionPreview).mockResolvedValue(preview)
		const { result } = renderHook(() => useAccountDeletionPreview(true), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(preview)
		expect(api.account.deletionPreview).toHaveBeenCalledWith(false)
	})

	it('passes the sole-workspace flag through to the preview request', async () => {
		vi.mocked(api.account.deletionPreview).mockResolvedValue({
			can_delete: false,
			blockers: [],
			leaving: [],
		})
		const { result } = renderHook(() => useAccountDeletionPreview(true, true), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.account.deletionPreview).toHaveBeenCalledWith(true)
	})
})

describe('useDeleteAccount', () => {
	it('clears stored auth after a successful delete', async () => {
		setApiKey('ank_test')
		vi.mocked(api.account.delete).mockResolvedValue({ deleted: true })
		const { result } = renderHook(() => useDeleteAccount(), { wrapper: TestWrapper })
		result.current.mutate({ password: 'pw', delete_sole_workspaces: true })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.account.delete).toHaveBeenCalledWith({
			password: 'pw',
			delete_sole_workspaces: true,
		})
		expect(getApiKey()).toBeNull()
	})

	it('keeps stored auth when the delete fails', async () => {
		setApiKey('ank_test')
		vi.mocked(api.account.delete).mockRejectedValue(new Error('Wrong password'))
		const { result } = renderHook(() => useDeleteAccount(), { wrapper: TestWrapper })
		result.current.mutate({ password: 'bad' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(getApiKey()).toBe('ank_test')
	})
})
