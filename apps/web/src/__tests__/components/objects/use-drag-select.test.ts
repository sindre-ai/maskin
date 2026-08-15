import {
	AUTOSCROLL_MAX_SPEED,
	AUTOSCROLL_MIN_SPEED,
	AUTOSCROLL_ZONE_PCT,
	LONG_PRESS_MOVE_TOLERANCE,
	LONG_PRESS_MS,
	computeRangeSelection,
} from '@/components/objects/data-table/use-drag-select'
import { describe, expect, it } from 'vitest'

const ORDERED = ['a', 'b', 'c', 'd', 'e']

function snapshot(state: Record<string, boolean>) {
	const m = new Map<string, boolean>()
	for (const id of ORDERED) m.set(id, !!state[id])
	return m
}

describe('computeRangeSelection', () => {
	it('forward drag from the anchor selects every crossed row when intent is select', () => {
		const result = computeRangeSelection({
			current: { a: true },
			orderedIds: ORDERED,
			anchorIdx: 0,
			prevIdx: 0,
			newIdx: 2,
			intent: 'select',
			originalState: snapshot({}),
		})
		expect(result).toEqual({ a: true, b: true, c: true })
	})

	it('reverse drag back across the anchor restores the pre-drag state, not the opposite of intent', () => {
		// Pre-drag: c was already selected; drag started on a (toggled on),
		// extended to d (selected a..d), then walked back to b. The rows now
		// outside the range (c, d) must restore their original state — c stays
		// selected because it was selected before, d unselects.
		const original = snapshot({ c: true })
		const afterExtend = computeRangeSelection({
			current: { a: true, c: true },
			orderedIds: ORDERED,
			anchorIdx: 0,
			prevIdx: 0,
			newIdx: 3,
			intent: 'select',
			originalState: original,
		})
		expect(afterExtend).toEqual({ a: true, b: true, c: true, d: true })

		const afterWalkBack = computeRangeSelection({
			current: afterExtend,
			orderedIds: ORDERED,
			anchorIdx: 0,
			prevIdx: 3,
			newIdx: 1,
			intent: 'select',
			originalState: original,
		})
		expect(afterWalkBack).toEqual({ a: true, b: true, c: true })
	})

	it('deselect intent clears every crossed row inside the range', () => {
		const result = computeRangeSelection({
			current: { a: true, b: true, c: true, d: true, e: true },
			orderedIds: ORDERED,
			anchorIdx: 1,
			prevIdx: 1,
			newIdx: 3,
			intent: 'deselect',
			originalState: snapshot({ a: true, b: true, c: true, d: true, e: true }),
		})
		expect(result).toEqual({ a: true, e: true })
	})

	it('deselect walking back across the anchor restores rows that were originally selected', () => {
		// Anchor at b (deselected on activation). User extended to d (cleared b..d),
		// then walked back to a (cleared a..b). The rows now outside the swept range
		// (c, d) restore to their original state — both were selected before.
		const original = snapshot({ a: true, b: true, c: true, d: true })
		const result = computeRangeSelection({
			current: { a: true },
			orderedIds: ORDERED,
			anchorIdx: 1,
			prevIdx: 3,
			newIdx: 0,
			intent: 'deselect',
			originalState: original,
		})
		expect(result).toEqual({ c: true, d: true })
	})

	it('does not mutate the input map or the originalState snapshot', () => {
		const current = { a: true }
		const original = snapshot({ a: true })
		computeRangeSelection({
			current,
			orderedIds: ORDERED,
			anchorIdx: 0,
			prevIdx: 0,
			newIdx: 2,
			intent: 'select',
			originalState: original,
		})
		expect(current).toEqual({ a: true })
		expect(original.get('a')).toBe(true)
	})

	it('exposes the hard-coded thresholds T5 committed to', () => {
		expect(LONG_PRESS_MS).toBe(500)
		expect(LONG_PRESS_MOVE_TOLERANCE).toBe(8)
		expect(AUTOSCROLL_ZONE_PCT).toBeCloseTo(0.15)
		expect(AUTOSCROLL_MIN_SPEED).toBe(2)
		expect(AUTOSCROLL_MAX_SPEED).toBe(16)
	})
})
