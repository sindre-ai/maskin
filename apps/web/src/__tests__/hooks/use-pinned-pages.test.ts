import { afterEach, describe, expect, it, vi } from 'vitest'

const WS = 'ws-1'
const KEY = `maskin-pinned-pages-${WS}`

vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: vi.fn((ids: string[]) =>
		ids.includes('work') ? [{ label: 'Bets', value: 'bet' }] : [],
	),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: vi.fn(() => ['work']),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: WS }),
}))

import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { usePinnedPages } from '@/hooks/use-pinned-pages'
import { DEFAULT_PINNED_IDS, setPinnedPageIds } from '@/lib/pinned-pages'
import { __resetPinnedPagesStoreForTests } from '@/stores/pinned-pages-store'
import { act, renderHook } from '@testing-library/react'
import { createWorkspaceWrapper } from '../setup'

afterEach(() => {
	localStorage.removeItem(KEY)
	__resetPinnedPagesStoreForTests()
	vi.restoreAllMocks()
})

describe('usePinnedPages', () => {
	it('returns default pinned pages when nothing is stored', () => {
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })
		const ids = result.current.pinnedPages.map((p) => p.id)
		for (const id of DEFAULT_PINNED_IDS) {
			expect(ids).toContain(id)
		}
	})

	it('returns stored pinned pages', () => {
		setPinnedPageIds(WS, ['pulse', 'agents'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })
		const ids = result.current.pinnedPages.map((p) => p.id)
		expect(ids).toEqual(['pulse', 'agents'])
	})

	it('pin adds a page and persists to localStorage', () => {
		setPinnedPageIds(WS, ['pulse'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		act(() => result.current.pin('agents'))

		expect(result.current.pinnedPages.map((p) => p.id)).toContain('agents')
		expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toContain('agents')
	})

	it('pin does not add a duplicate', () => {
		setPinnedPageIds(WS, ['pulse'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		act(() => result.current.pin('pulse'))

		const ids = result.current.pinnedPages.map((p) => p.id)
		expect(ids.filter((id) => id === 'pulse')).toHaveLength(1)
	})

	it('unpin removes a page and persists', () => {
		setPinnedPageIds(WS, ['pulse', 'agents'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		act(() => result.current.unpin('agents'))

		expect(result.current.pinnedPages.map((p) => p.id)).not.toContain('agents')
		expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).not.toContain('agents')
	})

	it('reorder moves an item to the target index', () => {
		setPinnedPageIds(WS, ['pulse', 'threads', 'agents'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		act(() => result.current.reorder(0, 2))

		const ids = result.current.pinnedPages.map((p) => p.id)
		expect(ids).toEqual(['threads', 'agents', 'pulse'])
	})

	it('isPinned reflects current state', () => {
		setPinnedPageIds(WS, ['pulse'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		expect(result.current.isPinned('pulse')).toBe(true)
		expect(result.current.isPinned('agents')).toBe(false)
	})

	it('filters out module-gated pages when modules are disabled', () => {
		vi.mocked(useEnabledModules).mockReturnValue([])
		setPinnedPageIds(WS, ['pulse', 'objects'])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		const ids = result.current.pinnedPages.map((p) => p.id)
		expect(ids).toContain('pulse')
		expect(ids).not.toContain('objects')
	})

	it('allPages excludes module-gated pages when modules are disabled', () => {
		vi.mocked(useEnabledModules).mockReturnValue([])
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		const ids = result.current.allPages.map((p) => p.id)
		expect(ids).not.toContain('objects')
	})

	it('isEditing starts as false', () => {
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })
		expect(result.current.isEditing).toBe(false)
	})

	it('setEditing toggles isEditing', () => {
		const { result } = renderHook(() => usePinnedPages(), { wrapper: createWorkspaceWrapper() })

		act(() => result.current.setEditing(true))
		expect(result.current.isEditing).toBe(true)

		act(() => result.current.setEditing(false))
		expect(result.current.isEditing).toBe(false)
	})

	// Regression test for the Codex finding on PR #402: two hook consumers
	// (sidebar + /pages) used to hold independent useState copies, so a pin
	// from one didn't update the other until remount/refresh.
	it('shares pinned state across two consumers — pin from one updates the other', () => {
		setPinnedPageIds(WS, ['pulse'])
		const wrapper = createWorkspaceWrapper()
		const sidebar = renderHook(() => usePinnedPages(), { wrapper })
		const pagesGrid = renderHook(() => usePinnedPages(), { wrapper })

		expect(sidebar.result.current.pinnedPages.map((p) => p.id)).toEqual(['pulse'])
		expect(pagesGrid.result.current.pinnedPages.map((p) => p.id)).toEqual(['pulse'])

		// Pin from the /pages grid; sidebar must reflect it without remount.
		act(() => pagesGrid.result.current.pin('agents'))
		expect(sidebar.result.current.pinnedPages.map((p) => p.id)).toEqual(['pulse', 'agents'])
		expect(pagesGrid.result.current.isPinned('agents')).toBe(true)

		// Unpin from the sidebar; /pages grid must reflect it without remount.
		act(() => sidebar.result.current.unpin('pulse'))
		expect(pagesGrid.result.current.pinnedPages.map((p) => p.id)).toEqual(['agents'])
		expect(sidebar.result.current.isPinned('pulse')).toBe(false)

		// Reorder from one; the other sees the new order.
		act(() => sidebar.result.current.pin('triggers'))
		act(() => sidebar.result.current.reorder(0, 1))
		expect(pagesGrid.result.current.pinnedPages.map((p) => p.id)).toEqual(['triggers', 'agents'])
	})
})
