import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useForYouViewMode } from '@/hooks/use-foryou-view-mode'

function clearCookie() {
	document.cookie = 'foryou_view_mode=; path=/; max-age=0'
}

describe('useForYouViewMode', () => {
	beforeEach(() => {
		clearCookie()
	})

	afterEach(() => {
		clearCookie()
	})

	it("defaults to 'card' when the cookie is unset", () => {
		const { result } = renderHook(() => useForYouViewMode())
		expect(result.current.mode).toBe('card')
	})

	it("setMode('list') writes the expected cookie string", () => {
		const { result } = renderHook(() => useForYouViewMode())

		act(() => {
			result.current.setMode('list')
		})

		expect(result.current.mode).toBe('list')
		expect(document.cookie).toContain('foryou_view_mode=list')
	})

	it("hydrates to 'list' on mount when the cookie is already set", () => {
		document.cookie = 'foryou_view_mode=list; path=/'

		const { result } = renderHook(() => useForYouViewMode())

		expect(result.current.mode).toBe('list')
	})
})
