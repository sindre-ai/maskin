import {
	TASK_ORDER_GAP,
	TASK_ORDER_INITIAL,
	computeReorderOrder,
	getTaskOrder,
	orderBetween,
	sortTasksByOrder,
} from '@/lib/task-order'
import { describe, expect, it } from 'vitest'

function task(
	id: string,
	overrides: { order?: number | null; createdAt?: string | null; metadata?: object } = {},
) {
	const metadata =
		overrides.metadata !== undefined
			? overrides.metadata
			: overrides.order === null || overrides.order === undefined
				? null
				: { order: overrides.order }
	return {
		id,
		metadata: metadata as Record<string, unknown> | null,
		createdAt: overrides.createdAt ?? null,
	}
}

describe('getTaskOrder', () => {
	it('returns the numeric order from metadata.order', () => {
		expect(getTaskOrder(task('a', { order: 42 }))).toBe(42)
	})

	it('returns null for tasks with no metadata', () => {
		expect(getTaskOrder({ id: 'a', metadata: null })).toBeNull()
	})

	it('returns null when metadata.order is missing', () => {
		expect(getTaskOrder({ id: 'a', metadata: { other: 1 } })).toBeNull()
	})

	it('returns null when metadata.order is non-numeric', () => {
		expect(getTaskOrder({ id: 'a', metadata: { order: 'first' } })).toBeNull()
	})

	it('returns null for NaN and Infinity, accepts 0 and negatives', () => {
		expect(getTaskOrder({ id: 'a', metadata: { order: Number.NaN } })).toBeNull()
		expect(getTaskOrder({ id: 'a', metadata: { order: Number.POSITIVE_INFINITY } })).toBeNull()
		expect(getTaskOrder({ id: 'a', metadata: { order: 0 } })).toBe(0)
		expect(getTaskOrder({ id: 'a', metadata: { order: -3.5 } })).toBe(-3.5)
	})
})

describe('orderBetween', () => {
	it('returns the seed value when the column is empty', () => {
		expect(orderBetween(null, null)).toBe(TASK_ORDER_INITIAL)
	})

	it('inserts at the head one gap below the current head', () => {
		expect(orderBetween(null, 100)).toBe(100 - TASK_ORDER_GAP)
	})

	it('inserts at the tail one gap above the current tail', () => {
		expect(orderBetween(100, null)).toBe(100 + TASK_ORDER_GAP)
	})

	it('returns the midpoint when both anchors are defined', () => {
		expect(orderBetween(100, 200)).toBe(150)
	})

	it('handles fractional anchors (mirrors bet-order.ts midpoint pattern)', () => {
		expect(orderBetween(1.0, 1.5)).toBeCloseTo(1.25, 12)
		expect(orderBetween(1.25, 1.5)).toBeCloseTo(1.375, 12)
	})

	it('throws when prev >= next', () => {
		expect(() => orderBetween(200, 100)).toThrow(/prev .* must be < next/)
		expect(() => orderBetween(50, 50)).toThrow(/prev .* must be < next/)
	})

	it('throws when the gap collapses below the minimum', () => {
		const a = 1
		const b = 1 + 1e-12
		expect(() => orderBetween(a, b)).toThrow(/gap collapsed/)
	})

	it('rejects non-finite anchors', () => {
		expect(() => orderBetween(Number.NaN, 1)).toThrow(/finite/)
		expect(() => orderBetween(1, Number.POSITIVE_INFINITY)).toThrow(/finite/)
	})
})

describe('sortTasksByOrder', () => {
	it('sorts tasks by metadata.order ascending', () => {
		const sorted = sortTasksByOrder([
			task('a', { order: 3 }),
			task('b', { order: 1 }),
			task('c', { order: 2 }),
		])
		expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a'])
	})

	it('places tasks with no order key after tasks that have one', () => {
		const sorted = sortTasksByOrder([
			task('no-order-1', { metadata: null }),
			task('ordered', { order: 5 }),
			task('no-order-2', { metadata: null }),
		])
		expect(sorted[0].id).toBe('ordered')
		expect(new Set([sorted[1].id, sorted[2].id])).toEqual(new Set(['no-order-1', 'no-order-2']))
	})

	it('breaks order ties by createdAt then id', () => {
		const sorted = sortTasksByOrder([
			task('z', { order: 1, createdAt: '2026-01-01T00:00:02Z' }),
			task('a', { order: 1, createdAt: '2026-01-01T00:00:01Z' }),
			task('m', { order: 1, createdAt: '2026-01-01T00:00:01Z' }),
		])
		expect(sorted.map((t) => t.id)).toEqual(['a', 'm', 'z'])
	})

	it('does not mutate the input array', () => {
		const input = [task('a', { order: 2 }), task('b', { order: 1 })]
		const before = input.map((t) => t.id)
		sortTasksByOrder(input)
		expect(input.map((t) => t.id)).toEqual(before)
	})

	it('returns an empty array for empty input', () => {
		expect(sortTasksByOrder([])).toEqual([])
	})
})

describe('computeReorderOrder', () => {
	const cards = [task('a', { order: 100 }), task('b', { order: 200 }), task('c', { order: 300 })]

	it('returns a midpoint when inserting between two cards', () => {
		// Insert d at index 1 → between a (100) and b (200)
		const order = computeReorderOrder([...cards, task('d', { order: 999 })], 'd', 1)
		expect(order).toBe(150)
	})

	it('returns one gap below the head when inserting at index 0', () => {
		const order = computeReorderOrder([...cards, task('d', { order: 999 })], 'd', 0)
		expect(order).toBe(100 - TASK_ORDER_GAP)
	})

	it('returns one gap above the tail when inserting at the end', () => {
		const order = computeReorderOrder([...cards, task('d', { order: 999 })], 'd', 3)
		expect(order).toBe(300 + TASK_ORDER_GAP)
	})

	it('clamps target indices outside the column to the head or tail', () => {
		expect(computeReorderOrder(cards, 'a', -5)).toBe(200 - TASK_ORDER_GAP)
		// 'a' is excluded from anchors; head becomes b(200), tail becomes c(300).
		expect(computeReorderOrder(cards, 'a', 99)).toBe(300 + TASK_ORDER_GAP)
	})

	it('excludes the moving card from the anchors so dropping in place is idempotent-shaped', () => {
		// Sorted column: a(100), b(200), c(300). Move b to index 1 (its current
		// visible slot). Anchors after exclusion: a(100), c(300). Midpoint is 200,
		// which equals b's existing order — caller can detect a no-op.
		const order = computeReorderOrder(cards, 'b', 1)
		expect(order).toBe(200)
	})

	it('drops a card moved to an empty column at the seed value', () => {
		expect(computeReorderOrder([], 'a', 0)).toBe(TASK_ORDER_INITIAL)
	})

	it('handles columns where some cards have no order yet', () => {
		const mixed = [
			task('a', { order: 100 }),
			task('b', { order: 200 }),
			task('no-order', { metadata: null }),
		]
		// Insert 'x' before the orderless card. anchors: prev=b(200), next=null.
		const order = computeReorderOrder([...mixed, task('x', { order: 999 })], 'x', 2)
		expect(order).toBe(200 + TASK_ORDER_GAP)
	})
})
