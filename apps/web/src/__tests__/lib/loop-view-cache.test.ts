import {
	dropCachedResult,
	formatUpdatedAt,
	readCachedResult,
	writeCachedResult,
} from '@/lib/loop-view-cache'
import { beforeEach, describe, expect, it } from 'vitest'

const RESULT = {
	groups: [{ key: 'open', count: 2, value: 2 }],
	total: { count: 2, value: 2 },
	rows_truncated: false,
	groups_truncated: false,
}

describe('loop view cache', () => {
	beforeEach(() => localStorage.clear())

	it('returns what was written, with the time it was written', () => {
		const at = writeCachedResult('ws-1', 'q', RESULT)
		expect(readCachedResult('ws-1', 'q')).toEqual({ result: RESULT, at })
	})

	it('keeps workspaces apart', () => {
		writeCachedResult('ws-1', 'q', RESULT)
		expect(readCachedResult('ws-2', 'q')).toBeNull()
	})

	it('forgets a dropped answer', () => {
		writeCachedResult('ws-1', 'q', RESULT)
		dropCachedResult('ws-1', 'q')
		expect(readCachedResult('ws-1', 'q')).toBeNull()
	})

	it('ignores an answer that is too old or not a result', () => {
		const old = Date.now() - 31 * 24 * 60 * 60 * 1000
		localStorage.setItem('maskin-loop-view:ws-1:old', JSON.stringify({ at: old, result: RESULT }))
		localStorage.setItem(
			'maskin-loop-view:ws-1:bad',
			JSON.stringify({ at: Date.now(), result: {} }),
		)
		localStorage.setItem('maskin-loop-view:ws-1:junk', 'not json')
		expect(readCachedResult('ws-1', 'old')).toBeNull()
		expect(readCachedResult('ws-1', 'bad')).toBeNull()
		expect(readCachedResult('ws-1', 'junk')).toBeNull()
	})

	it('formats the time as day with ordinal, month name and hh:mm', () => {
		expect(formatUpdatedAt(new Date(2026, 10, 4, 9, 5).getTime())).toBe('4th Nov 09:05')
		expect(formatUpdatedAt(new Date(2026, 0, 1, 7, 3).getTime())).toBe('1st Jan 07:03')
		expect(formatUpdatedAt(new Date(2026, 5, 22, 18, 45).getTime())).toBe('22nd Jun 18:45')
		expect(formatUpdatedAt(new Date(2026, 7, 3, 0, 0).getTime())).toBe('3rd Aug 00:00')
	})

	it('uses th for 11 to 13 and st/nd/rd again from 21', () => {
		const at = (day: number) => formatUpdatedAt(new Date(2026, 2, day, 12, 0).getTime())
		expect([11, 12, 13, 21, 23, 30, 31].map(at)).toEqual([
			'11th Mar 12:00',
			'12th Mar 12:00',
			'13th Mar 12:00',
			'21st Mar 12:00',
			'23rd Mar 12:00',
			'30th Mar 12:00',
			'31st Mar 12:00',
		])
	})
})
