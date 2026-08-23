import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		featureFlags: { get: vi.fn() },
	},
}))

import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { api } from '@/lib/api'
import { loadFeatureFlags } from '@/lib/feature-flags'
import { TestWrapper } from '../setup'

const STORAGE_KEY = 'maskin-feature-flags:1'

beforeEach(() => {
	localStorage.clear()
	vi.mocked(api.featureFlags.get).mockReset()
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('useFeatureFlag', () => {
	it('returns false — never undefined — for an unknown flag', () => {
		const { result } = renderHook(() => useFeatureFlag('never-heard-of-it'), {
			wrapper: TestWrapper,
		})
		expect(result.current).toBe(false)
	})

	it('returns true once the flag resolves true from the server', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'new-design': true } })
		const { result } = renderHook(() => useFeatureFlag('new-design'), { wrapper: TestWrapper })

		await act(async () => {
			await loadFeatureFlags()
		})

		expect(result.current).toBe(true)
	})

	it('re-renders when a background revalidation flips the value', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'new-design': true } })
		const { result } = renderHook(() => useFeatureFlag('new-design'), { wrapper: TestWrapper })
		await act(async () => {
			await loadFeatureFlags()
		})
		expect(result.current).toBe(true)

		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'new-design': false } })
		await act(async () => {
			await loadFeatureFlags()
		})

		expect(result.current).toBe(false)
	})

	it('lets the test-only localStorage override win over the server value', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'new-design': false } })
		await act(async () => {
			await loadFeatureFlags()
		})
		localStorage.setItem('ff:new-design', 'on')

		const { result } = renderHook(() => useFeatureFlag('new-design'), { wrapper: TestWrapper })
		expect(result.current).toBe(true)
	})

	it('stays false when the endpoint fails, and does not throw', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({}))
		vi.mocked(api.featureFlags.get).mockRejectedValue(new Error('500'))
		const { result } = renderHook(() => useFeatureFlag('new-design'), { wrapper: TestWrapper })

		await act(async () => {
			await loadFeatureFlags()
		})

		expect(result.current).toBe(false)
	})
})
