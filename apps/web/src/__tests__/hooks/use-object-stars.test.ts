import { useObjectStars } from '@/hooks/use-object-stars'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fresh workspace id per test. The module keeps a session fallback map for
// workspaces whose write to `localStorage` threw, and that map outlives a
// `localStorage.clear()` — a shared id would leak the quota test's set into
// the ones after it.
let counter = 0
let WORKSPACE = ''
let OTHER_WORKSPACE = ''
let KEY = ''

describe('useObjectStars', () => {
	beforeEach(() => {
		counter += 1
		WORKSPACE = `workspace-${counter}-a`
		OTHER_WORKSPACE = `workspace-${counter}-b`
		KEY = `maskin-object-stars:${WORKSPACE}`
		localStorage.clear()
		vi.restoreAllMocks()
	})

	it('seeds from localStorage', () => {
		localStorage.setItem(KEY, JSON.stringify(['a', 'b']))
		const { result } = renderHook(() => useObjectStars(WORKSPACE))
		expect(result.current.isStarred('a')).toBe(true)
		expect(result.current.isStarred('c')).toBe(false)
	})

	it('toggles a star on and off, persisting each time', () => {
		const { result } = renderHook(() => useObjectStars(WORKSPACE))

		act(() => result.current.toggleStar('a'))
		expect(result.current.starredIds).toEqual(new Set(['a']))
		expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual(['a'])

		act(() => result.current.toggleStar('a'))
		expect(result.current.starredIds).toEqual(new Set())
		expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([])
	})

	// The bug this guards: the list row and the objects route each call this
	// hook, and the route's copy drives the Starred filter and its count. The
	// `storage` event does not fire in the tab that wrote, so without an
	// explicit same-tab notification the route's set stayed stale until remount
	// — unstarring a row left it in a Starred-filtered list.
	it('reflects a star set through one instance in every other instance', () => {
		const row = renderHook(() => useObjectStars(WORKSPACE))
		const route = renderHook(() => useObjectStars(WORKSPACE))

		act(() => row.result.current.toggleStar('a'))
		expect(route.result.current.starredIds).toEqual(new Set(['a']))

		act(() => route.result.current.toggleStar('a'))
		expect(row.result.current.starredIds).toEqual(new Set())
	})

	it('ignores writes for a different workspace', () => {
		const mine = renderHook(() => useObjectStars(WORKSPACE))
		const theirs = renderHook(() => useObjectStars(OTHER_WORKSPACE))

		act(() => theirs.result.current.toggleStar('a'))
		expect(mine.result.current.starredIds).toEqual(new Set())
	})

	it('keeps stars for the session when localStorage rejects the write', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError')
		})
		const { result } = renderHook(() => useObjectStars(WORKSPACE))

		act(() => result.current.toggleStar('a'))
		expect(result.current.starredIds).toEqual(new Set(['a']))

		act(() => result.current.toggleStar('b'))
		expect(result.current.starredIds).toEqual(new Set(['a', 'b']))
	})

	it('falls back to an empty set on a corrupt stored value', () => {
		localStorage.setItem(KEY, 'not json')
		const { result } = renderHook(() => useObjectStars(WORKSPACE))
		expect(result.current.starredIds).toEqual(new Set())
	})

	it('re-reads when another tab writes', () => {
		const { result } = renderHook(() => useObjectStars(WORKSPACE))
		localStorage.setItem(KEY, JSON.stringify(['a']))

		act(() => {
			window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
		})
		expect(result.current.starredIds).toEqual(new Set(['a']))
	})
})
