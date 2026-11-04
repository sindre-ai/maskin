import { ApiError } from '@/lib/api'
import { VIEWER_READ_ONLY_MESSAGE, canWriteWithRole, isViewerRefusal } from '@/lib/workspace-role'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn() } }))

describe('canWriteWithRole', () => {
	it('is false only for viewers', () => {
		expect(canWriteWithRole('viewer')).toBe(false)
		for (const role of ['owner', 'admin', 'member', 'something-new', undefined, null]) {
			expect(canWriteWithRole(role)).toBe(true)
		}
	})
})

describe('refused viewer writes', () => {
	beforeEach(() => toastError.mockClear())

	it('recognises the server refusal and nothing else', () => {
		const refusal = new ApiError(403, 'Viewers have read-only access to this workspace')
		expect(isViewerRefusal(refusal)).toBe(true)
		expect(isViewerRefusal(new ApiError(403, 'Only a human admin or owner can do this'))).toBe(
			false,
		)
		expect(isViewerRefusal(new ApiError(404, refusal.message))).toBe(false)
		expect(isViewerRefusal(new Error(refusal.message))).toBe(false)
	})

	it('shows one plain message for a refused save', async () => {
		const { queryClient } = await import('@/lib/query')
		const refusal = new ApiError(403, 'Viewers have read-only access to this workspace')
		await queryClient
			.getMutationCache()
			.build(queryClient, { mutationFn: () => Promise.reject(refusal) })
			.execute(undefined)
			.catch(() => {})
		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith(VIEWER_READ_ONLY_MESSAGE, { id: 'viewer-read-only' })
	})
})
