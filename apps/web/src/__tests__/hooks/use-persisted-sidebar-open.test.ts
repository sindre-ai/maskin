import { usePersistedSidebarOpen } from '@/hooks/use-persisted-sidebar-open'
import { SIDEBAR_STORAGE_PREFIX } from '@/lib/nav-view-keys'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('usePersistedSidebarOpen', () => {
	beforeEach(() => {
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}objects`, 'false')
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}objects-detail`, 'true')
	})
	afterEach(() => localStorage.clear())

	it('initializes open state from the stored value for the view key', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen('objects'))
		expect(result.current.open).toBe(false)
	})

	it('falls back to home storage when no view key resolves', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen(null))
		expect(result.current.open).toBe(true)
	})

	it('writes through to storage when setOpen is called', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen('objects'))
		act(() => result.current.setOpen(true))
		expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}objects`)).toBe('true')
	})

	it('accepts an updater function', () => {
		const { result } = renderHook(() => usePersistedSidebarOpen('objects'))
		act(() => result.current.setOpen((prev) => !prev))
		expect(result.current.open).toBe(true)
		act(() => result.current.setOpen((prev) => !prev))
		expect(result.current.open).toBe(false)
	})

	it("resets from the new key's storage when the view changes (per-view collapse state)", () => {
		const { result, rerender } = renderHook(
			({ key }: { key: string | null }) => usePersistedSidebarOpen(key),
			{ initialProps: { key: 'objects' } },
		)
		expect(result.current.open).toBe(false)
		rerender({ key: 'objects-detail' })
		expect(result.current.open).toBe(true)
	})
})
