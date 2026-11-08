import {
	LATER_MAX_ENTRIES,
	LATER_STORAGE_KEY,
	type LaterStore,
	addLater,
	isSetAside,
	laterForWorkspace,
	laterKey,
	laterMinDate,
	laterOptionFromDate,
	laterOptions,
	laterToast,
	nextLaterDue,
	parseLaterStore,
	pruneLaterStore,
	readLaterStore,
	removeLater,
	writeLaterStore,
} from '@/lib/foryou-later'
import { beforeEach, describe, expect, it } from 'vitest'

const NOW = new Date(2026, 10, 2, 10, 0, 0).getTime() // Monday 2 Nov 2026, 10:00 local
const entry = (until: number, eventId = 5) => ({ until, label: 'Tomorrow, 08:00', eventId })

describe('storage key', () => {
	it('is versioned', () => {
		expect(LATER_STORAGE_KEY).toMatch(/:v\d+$/)
	})
})

describe('parseLaterStore', () => {
	it('returns an empty store for nothing, junk or the wrong shape', () => {
		expect(parseLaterStore(null, NOW)).toEqual({})
		expect(parseLaterStore('{not json', NOW)).toEqual({})
		expect(parseLaterStore('[1,2]', NOW)).toEqual({})
		expect(parseLaterStore('"x"', NOW)).toEqual({})
	})

	it('keeps valid entries and drops malformed or due ones', () => {
		const raw = JSON.stringify({
			a: entry(NOW + 1000),
			b: { until: 'soon', label: 'x', eventId: 1 },
			c: entry(NOW - 1),
			d: null,
		})
		expect(Object.keys(parseLaterStore(raw, NOW))).toEqual(['a'])
	})
})

describe('pruneLaterStore', () => {
	it('is bounded: over the cap, the entries that come back soonest go first', () => {
		const store: LaterStore = {}
		for (let i = 0; i < LATER_MAX_ENTRIES + 10; i++) store[`k${i}`] = entry(NOW + 1000 + i)
		const pruned = pruneLaterStore(store, NOW)
		expect(Object.keys(pruned)).toHaveLength(LATER_MAX_ENTRIES)
		expect(pruned.k0).toBeUndefined()
		expect(pruned[`k${LATER_MAX_ENTRIES + 9}`]).toBeDefined()
	})
})

describe('add, remove and scope', () => {
	it('adds an entry and removes it again', () => {
		const key = laterKey('ws-1', 'object:x')
		const added = addLater({}, key, entry(NOW + 5000), NOW)
		expect(added[key]).toBeDefined()
		expect(removeLater(added, key)).toEqual({})
	})

	it('returns the same store when removing something that is not there', () => {
		const store = {}
		expect(removeLater(store, 'nope')).toBe(store)
	})

	it('reads one workspace at a time, keyed by card', () => {
		const store: LaterStore = {
			[laterKey('ws-1', 'object:x')]: entry(NOW + 1),
			[laterKey('ws-2', 'object:y')]: entry(NOW + 1),
		}
		expect(Object.keys(laterForWorkspace(store, 'ws-1'))).toEqual(['object:x'])
	})
})

describe('isSetAside', () => {
	it('is true until it is due', () => {
		expect(isSetAside(entry(NOW + 1000), 5, NOW)).toBe(true)
		expect(isSetAside(entry(NOW), 5, NOW)).toBe(false)
	})

	it('comes back when the thread has a newer event', () => {
		expect(isSetAside(entry(NOW + 1000, 5), 6, NOW)).toBe(false)
	})

	it('ignores a stale or missing entry', () => {
		expect(isSetAside(undefined, 5, NOW)).toBe(false)
	})
})

describe('nextLaterDue', () => {
	it('finds the soonest future time, or null', () => {
		expect(nextLaterDue({}, NOW)).toBeNull()
		expect(nextLaterDue({ a: entry(NOW + 9), b: entry(NOW + 3), c: entry(NOW - 1) }, NOW)).toBe(
			NOW + 3,
		)
	})
})

describe('laterOptions', () => {
	it('offers evening, tomorrow, Monday and next week from a Wednesday morning', () => {
		const wed = new Date(2026, 10, 4, 9, 0, 0)
		const options = laterOptions(wed)
		expect(options.map((o) => o.label)).toEqual([
			'This evening, 18:00',
			'Tomorrow, 08:00',
			'Monday, 08:00',
			'Next week, Monday 08:00',
		])
		expect(new Date(options[2]?.until ?? 0).getDay()).toBe(1)
		expect(new Date(options[2]?.until ?? 0).getDate()).toBe(9)
		expect(new Date(options[3]?.until ?? 0).getDate()).toBe(16)
	})

	it('drops "This evening" once 18:00 has passed and "Monday" when tomorrow is Monday', () => {
		const sunNight = new Date(2026, 10, 1, 19, 0, 0)
		expect(laterOptions(sunNight).map((o) => o.label)).toEqual([
			'Tomorrow, 08:00',
			'Next week, Monday 08:00',
		])
	})

	it('only ever offers a time in the future', () => {
		for (const option of laterOptions(new Date(NOW))) expect(option.until).toBeGreaterThan(NOW)
	})
})

describe('laterOptionFromDate', () => {
	it('turns a picked day into 08:00 on that day', () => {
		const option = laterOptionFromDate('2026-11-20', new Date(NOW))
		expect(option?.label).toBe('Friday 20 November, 08:00')
		expect(new Date(option?.until ?? 0).getHours()).toBe(8)
	})

	it('rejects junk and days that are not ahead', () => {
		expect(laterOptionFromDate('', new Date(NOW))).toBeNull()
		expect(laterOptionFromDate('20/11/2026', new Date(NOW))).toBeNull()
		expect(laterOptionFromDate('2026-11-02', new Date(NOW))).toBeNull()
	})

	it('sets the earliest pickable day to tomorrow', () => {
		expect(laterMinDate(new Date(NOW))).toBe('2026-11-03')
	})
})

describe('laterToast', () => {
	it('reads as a sentence', () => {
		expect(laterToast('Tomorrow, 08:00')).toBe('Back tomorrow, 08:00. Only you are reminded.')
	})
})

describe('localStorage round trip', () => {
	beforeEach(() => localStorage.clear())

	it('writes and reads back, and survives corrupt storage', () => {
		const store = addLater({}, laterKey('ws-1', 'object:x'), entry(Date.now() + 60_000), Date.now())
		writeLaterStore(store)
		expect(readLaterStore()).toEqual(store)
		localStorage.setItem(LATER_STORAGE_KEY, '%%%')
		expect(readLaterStore()).toEqual({})
	})
})
