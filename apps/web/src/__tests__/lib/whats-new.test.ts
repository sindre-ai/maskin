import {
	WHATS_NEW_STORAGE_KEY,
	formatWhatsNewDate,
	newestUndismissed,
	readDismissedWhatsNew,
	sortWhatsNew,
} from '@/lib/whats-new'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const entries = [
	{ id: 'old', title: 'Old', body: 'b', date: '2026-10-01' },
	{ id: 'new', title: 'New', body: 'b', date: '2026-11-05' },
	{ id: 'mid', title: 'Mid', body: 'b', date: '2026-10-20' },
]

describe('whats-new', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('sorts newest first without mutating the input', () => {
		expect(sortWhatsNew(entries).map((e) => e.id)).toEqual(['new', 'mid', 'old'])
		expect(entries[0]?.id).toBe('old')
	})

	it('returns the newest entry that is not dismissed', () => {
		expect(newestUndismissed(entries, [])?.id).toBe('new')
		expect(newestUndismissed(entries, ['new'])?.id).toBe('mid')
	})

	it('returns null when every entry is dismissed', () => {
		expect(newestUndismissed(entries, ['new', 'mid', 'old'])).toBeNull()
	})

	it('treats corrupt storage as nothing dismissed', () => {
		localStorage.setItem(WHATS_NEW_STORAGE_KEY, '{not json')
		expect(readDismissedWhatsNew()).toEqual([])
		localStorage.setItem(WHATS_NEW_STORAGE_KEY, '{"a":1}')
		expect(readDismissedWhatsNew()).toEqual([])
		localStorage.setItem(WHATS_NEW_STORAGE_KEY, '["x",3,null]')
		expect(readDismissedWhatsNew()).toEqual(['x'])
	})

	it('treats blocked storage as nothing dismissed', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked')
		})
		expect(readDismissedWhatsNew()).toEqual([])
	})

	it('formats the date as day and short month', () => {
		expect(formatWhatsNewDate('2026-11-05')).toBe('5 Nov')
		expect(formatWhatsNewDate('nope')).toBe('nope')
	})
})
