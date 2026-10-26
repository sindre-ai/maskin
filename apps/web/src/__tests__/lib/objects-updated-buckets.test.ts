import {
	UPDATED_BUCKETS,
	startOfLocalDay,
	updatedBucketOf,
	updatedBucketWindow,
} from '@/lib/objects-updated-buckets'
import { describe, expect, it } from 'vitest'

// Local noon on a fixed day, so the bucket boundaries do not depend on when the
// suite runs or on the machine's timezone.
const NOW = new Date(2026, 4, 10, 12, 0, 0)

function inWindow(at: Date, window: { after?: Date; before?: Date }) {
	return (!window.after || at > window.after) && (!window.before || at < window.before)
}

describe('startOfLocalDay', () => {
	it('returns local midnight of the given day', () => {
		const start = startOfLocalDay(NOW)
		expect(start.getFullYear()).toBe(2026)
		expect(start.getMonth()).toBe(4)
		expect(start.getDate()).toBe(10)
		expect(start.getHours()).toBe(0)
		expect(start.getMinutes()).toBe(0)
	})
})

describe('updatedBucketWindow', () => {
	// The API filters on these windows and the chip counts bucket the same rows,
	// so a row must fall in the window of exactly the bucket `updatedBucketOf`
	// puts it in — otherwise a chip's count and the rows it opens would disagree.
	const samples = [
		new Date(2026, 4, 10, 0, 0, 0),
		new Date(2026, 4, 10, 11, 59, 0),
		new Date(2026, 4, 9, 23, 59, 59),
		new Date(2026, 4, 9, 0, 0, 0),
		new Date(2026, 4, 8, 23, 59, 59),
		new Date(2026, 4, 4, 0, 0, 0),
		new Date(2026, 4, 3, 23, 59, 59),
		new Date(2026, 0, 1, 12, 0, 0),
	]

	it.each(samples.map((at) => [at.toISOString(), at] as const))(
		'puts %s in the window of the bucket updatedBucketOf picks, and no other',
		(_label, at) => {
			const expected = updatedBucketOf(at.toISOString(), NOW)
			const matching = UPDATED_BUCKETS.filter((bucket) =>
				inWindow(at, updatedBucketWindow(bucket, NOW)),
			)
			expect(matching).toEqual([expected])
		},
	)

	it('leaves "today" open-ended and "older" with no lower bound', () => {
		expect(updatedBucketWindow('today', NOW).before).toBeUndefined()
		expect(updatedBucketWindow('older', NOW).after).toBeUndefined()
	})
})
