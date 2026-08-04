import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
	getStoredActor: vi.fn(),
}))

import { useForyouRedesignFlag } from '@/hooks/use-foryou-redesign-flag'
import { getStoredActor } from '@/lib/auth'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useForyouRedesignFlag', () => {
	it('returns true for Sebastian', () => {
		vi.mocked(getStoredActor).mockReturnValue({
			id: '3e16ed51-e5e1-4b87-959f-7eda01b21bea',
			name: 'Sebastian',
			type: 'human',
			email: null,
		})
		const { result } = renderHook(() => useForyouRedesignFlag())
		expect(result.current).toBe(true)
	})

	it('returns true for Magnus', () => {
		vi.mocked(getStoredActor).mockReturnValue({
			id: '08964c08-4ea5-45b0-bfa9-251f956909c7',
			name: 'Magnus',
			type: 'human',
			email: null,
		})
		const { result } = renderHook(() => useForyouRedesignFlag())
		expect(result.current).toBe(true)
	})

	it('returns false for a non-founder actor', () => {
		vi.mocked(getStoredActor).mockReturnValue({
			id: '11111111-1111-1111-1111-111111111111',
			name: 'Someone else',
			type: 'human',
			email: null,
		})
		const { result } = renderHook(() => useForyouRedesignFlag())
		expect(result.current).toBe(false)
	})

	it('returns false when no actor is stored', () => {
		vi.mocked(getStoredActor).mockReturnValue(null)
		const { result } = renderHook(() => useForyouRedesignFlag())
		expect(result.current).toBe(false)
	})

	it('honours the DEV-only localStorage override even without a founder actor', () => {
		vi.mocked(getStoredActor).mockReturnValue(null)
		localStorage.setItem('maskin-flag-foryou-redesign', '1')
		try {
			const { result } = renderHook(() => useForyouRedesignFlag())
			expect(result.current).toBe(true)
		} finally {
			localStorage.removeItem('maskin-flag-foryou-redesign')
		}
	})
})
