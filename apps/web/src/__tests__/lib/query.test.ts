import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

// Must import after mock setup
import { ApiError } from '@/lib/api'
import { queryClient } from '@/lib/query'
import { toast } from 'sonner'

describe('queryClient', () => {
	describe('default query options', () => {
		it('has staleTime of 30 seconds', () => {
			expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(30_000)
		})

		it('disables refetchOnWindowFocus', () => {
			expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
		})
	})

	describe('retry logic', () => {
		const retry = queryClient.getDefaultOptions().queries?.retry as (
			failureCount: number,
			error: Error,
		) => boolean

		it('does not retry 4xx ApiErrors', () => {
			expect(retry(0, new ApiError(400, 'Bad Request'))).toBe(false)
			expect(retry(0, new ApiError(404, 'Not Found'))).toBe(false)
			expect(retry(0, new ApiError(422, 'Validation Error'))).toBe(false)
		})

		it('retries non-4xx errors up to 3 times', () => {
			const serverError = new ApiError(500, 'Server Error')
			expect(retry(0, serverError)).toBe(true)
			expect(retry(1, serverError)).toBe(true)
			expect(retry(2, serverError)).toBe(true)
			expect(retry(3, serverError)).toBe(false)
		})

		it('retries generic errors up to 3 times', () => {
			const genericError = new Error('Network error')
			expect(retry(0, genericError)).toBe(true)
			expect(retry(2, genericError)).toBe(true)
			expect(retry(3, genericError)).toBe(false)
		})
	})

	describe('retryDelay', () => {
		const retryDelay = queryClient.getDefaultOptions().queries?.retryDelay as (
			attemptIndex: number,
		) => number

		it('uses exponential backoff capped at 30 seconds', () => {
			expect(retryDelay(0)).toBe(1000)
			expect(retryDelay(1)).toBe(2000)
			expect(retryDelay(2)).toBe(4000)
			expect(retryDelay(5)).toBe(30_000) // capped
			expect(retryDelay(10)).toBe(30_000) // still capped
		})
	})

	describe('mutation cache onError', () => {
		function triggerMutationError(error: Error) {
			// Access the mutation cache's onError handler
			const cache = queryClient.getMutationCache()
			const config = (cache as unknown as { config: { onError: (error: Error) => void } }).config
			config.onError(error)
		}

		it('shows toast for generic errors', () => {
			triggerMutationError(new Error('Something unexpected'))
			expect(toast.error).toHaveBeenCalledWith('Something went wrong')
		})

		it('shows toast with ApiError message', () => {
			triggerMutationError(new ApiError(500, 'Database connection failed'))
			expect(toast.error).toHaveBeenCalledWith('Database connection failed')
		})

		it('suppresses toast when ApiError has field errors', () => {
			vi.mocked(toast.error).mockClear()
			const error = new ApiError(422, 'Validation failed', { title: ['Required'] })
			triggerMutationError(error)
			expect(toast.error).not.toHaveBeenCalled()
		})
	})
})
