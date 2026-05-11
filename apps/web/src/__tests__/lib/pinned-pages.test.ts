import {
	ALL_PAGES,
	CATEGORY_LABELS,
	DEFAULT_PINNED_IDS,
	getPageById,
	getPagesByCategory,
	getPinnedPageIds,
	setPinnedPageIds,
} from '@/lib/pinned-pages'
import { afterEach, describe, expect, it } from 'vitest'

const WS = 'ws-test-123'
const KEY = `maskin-pinned-pages-${WS}`

afterEach(() => {
	localStorage.removeItem(KEY)
})

describe('getPinnedPageIds', () => {
	it('returns default ids when nothing is stored', () => {
		expect(getPinnedPageIds(WS)).toEqual(DEFAULT_PINNED_IDS)
	})

	it('returns stored ids when present', () => {
		localStorage.setItem(KEY, JSON.stringify(['pulse', 'threads']))
		expect(getPinnedPageIds(WS)).toEqual(['pulse', 'threads'])
	})

	it('falls back to defaults when stored value is not an array', () => {
		localStorage.setItem(KEY, JSON.stringify({ bad: true }))
		expect(getPinnedPageIds(WS)).toEqual(DEFAULT_PINNED_IDS)
	})

	it('falls back to defaults when stored value is invalid JSON', () => {
		localStorage.setItem(KEY, 'not-json')
		expect(getPinnedPageIds(WS)).toEqual(DEFAULT_PINNED_IDS)
	})

	it('filters out non-string entries from stored array', () => {
		localStorage.setItem(KEY, JSON.stringify(['pulse', 42, null, 'agents']))
		expect(getPinnedPageIds(WS)).toEqual(['pulse', 'agents'])
	})
})

describe('setPinnedPageIds', () => {
	it('writes the ids to localStorage', () => {
		setPinnedPageIds(WS, ['pulse', 'threads'])
		expect(localStorage.getItem(KEY)).toBe(JSON.stringify(['pulse', 'threads']))
	})

	it('overwrites previous value', () => {
		setPinnedPageIds(WS, ['pulse'])
		setPinnedPageIds(WS, ['agents', 'triggers'])
		const stored = localStorage.getItem(KEY)
		expect(JSON.parse(stored ?? '[]')).toEqual(['agents', 'triggers'])
	})
})

describe('getPageById', () => {
	it('returns the page for a known id', () => {
		const page = getPageById('pulse')
		expect(page).toBeDefined()
		expect(page?.label).toBe('Pulse')
	})

	it('returns undefined for an unknown id', () => {
		expect(getPageById('nonexistent')).toBeUndefined()
	})
})

describe('getPagesByCategory', () => {
	it('returns a map with all category keys', () => {
		const map = getPagesByCategory()
		expect(map.has('workspace')).toBe(true)
		expect(map.has('library')).toBe(true)
		expect(map.has('settings')).toBe(true)
	})

	it('puts pulse and threads in workspace category', () => {
		const map = getPagesByCategory()
		const workspace = map.get('workspace') ?? []
		const ids = workspace.map((p) => p.id)
		expect(ids).toContain('pulse')
		expect(ids).toContain('threads')
	})

	it('accounts for all pages', () => {
		const map = getPagesByCategory()
		const total = [...map.values()].reduce((sum, pages) => sum + pages.length, 0)
		expect(total).toBe(ALL_PAGES.length)
	})
})

describe('CATEGORY_LABELS', () => {
	it('has labels for all categories', () => {
		expect(CATEGORY_LABELS.workspace).toBeDefined()
		expect(CATEGORY_LABELS.library).toBeDefined()
		expect(CATEGORY_LABELS.settings).toBeDefined()
	})
})
