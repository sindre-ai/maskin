import { describe, expect, it } from 'vitest'
import { countBy } from '../../lib/count-by'

describe('countBy', () => {
	it('returns only all:0 for empty array', () => {
		expect(countBy([], (x: string) => x)).toEqual({ all: 0 })
	})

	it('counts items by key', () => {
		const items = [{ type: 'insight' }, { type: 'bet' }, { type: 'insight' }, { type: 'task' }]
		expect(countBy(items, (i) => i.type)).toEqual({
			all: 4,
			insight: 2,
			bet: 1,
			task: 1,
		})
	})

	it('handles single type', () => {
		const items = [{ type: 'cron' }, { type: 'cron' }]
		expect(countBy(items, (i) => i.type)).toEqual({ all: 2, cron: 2 })
	})
})
