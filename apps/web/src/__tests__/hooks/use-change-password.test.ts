import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		auth: { changePassword: vi.fn() },
	},
}))

vi.mock('@/lib/auth', () => ({
	setApiKey: vi.fn(),
}))

import { useChangePassword } from '@/hooks/use-auth'
import { api } from '@/lib/api'
import { setApiKey } from '@/lib/auth'
import { buildActorWithKey } from '../factories'
import { TestWrapper } from '../setup'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useChangePassword', () => {
	it('calls the password endpoint and rotates the stored api key on success', async () => {
		const rotated = buildActorWithKey({ id: 'actor-1', api_key: 'ank_new_key' })
		vi.mocked(api.auth.changePassword).mockResolvedValue(rotated)

		const { result } = renderHook(() => useChangePassword(), { wrapper: TestWrapper })

		await act(async () => {
			await result.current.mutateAsync({
				current_password: 'oldpass',
				new_password: 'newpass12',
			})
		})

		expect(api.auth.changePassword).toHaveBeenCalledWith({
			current_password: 'oldpass',
			new_password: 'newpass12',
		})
		expect(setApiKey).toHaveBeenCalledWith('ank_new_key')
	})

	it('does not rotate the stored api key when the request fails', async () => {
		vi.mocked(api.auth.changePassword).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useChangePassword(), { wrapper: TestWrapper })

		await act(async () => {
			result.current.mutate({ current_password: 'wrong', new_password: 'newpass12' })
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(setApiKey).not.toHaveBeenCalled()
	})
})
