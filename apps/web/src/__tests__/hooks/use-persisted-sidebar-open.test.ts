import { usePersistedSidebarOpen } from '@/hooks/use-persisted-sidebar-open'
import { SIDEBAR_STORAGE_PREFIX } from '@/lib/nav-view-keys'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

describe('usePersistedSidebarOpen', () => {
	afterEach(() => localStorage.clear())

	it('starts open when nothing is stored', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen())
		expect(result.current.open).toBe(true)
	})

	it('reads the stored app-wide value', () => {
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}home`, 'false')
		const { result } = renderHook(() => usePersistedSidebarOpen())
		expect(result.current.open).toBe(false)
	})

	it('ignores a collapse remembered for one view', () => {
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}agents`, 'false')
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}marketplace`, 'false')
		const { result } = renderHook(() => usePersistedSidebarOpen())
		expect(result.current.open).toBe(true)
	})

	it('writes through to storage when setOpen is called', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen())
		act(() => result.current.setOpen(false))
		expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}home`)).toBe('false')
	})

	it('accepts an updater function', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen())
		act(() => result.current.setOpen((prev) => !prev))
		expect(result.current.open).toBe(false)
		act(() => result.current.setOpen((prev) => !prev))
		expect(result.current.open).toBe(true)
	})
})
