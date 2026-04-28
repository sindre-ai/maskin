import { computeNewOrderForInsert, getEffectiveOrder, sortBetsByOrder } from '@/lib/bet-order'
import { describe, expect, it } from 'vitest'
import { buildObjectResponse } from '../factories'

describe('getEffectiveOrder', () => {
	it('returns metadata.order when set as a number', () => {
		const bet = buildObjectResponse({ metadata: { order: 42 } })
		expect(getEffectiveOrder(bet)).toBe(42)
	})

	it('falls back to Date.parse(createdAt) when metadata.order is missing', () => {
		const bet = buildObjectResponse({
			metadata: null,
			createdAt: '2026-04-01T00:00:00Z',
		})
		expect(getEffectiveOrder(bet)).toBe(Date.parse('2026-04-01T00:00:00Z'))
	})

	it('ignores non-numeric metadata.order values', () => {
		const bet = buildObjectResponse({
			metadata: { order: 'not-a-number' },
			createdAt: '2026-04-01T00:00:00Z',
		})
		expect(getEffectiveOrder(bet)).toBe(Date.parse('2026-04-01T00:00:00Z'))
	})

	it('returns 0 when both metadata.order and createdAt are absent', () => {
		const bet = buildObjectResponse({ metadata: null, createdAt: null })
		expect(getEffectiveOrder(bet)).toBe(0)
	})
})

describe('sortBetsByOrder', () => {
	it('sorts higher order first', () => {
		const a = buildObjectResponse({ id: 'a', metadata: { order: 1 } })
		const b = buildObjectResponse({ id: 'b', metadata: { order: 3 } })
		const c = buildObjectResponse({ id: 'c', metadata: { order: 2 } })
		const sorted = sortBetsByOrder([a, b, c])
		expect(sorted.map((bet) => bet.id)).toEqual(['b', 'c', 'a'])
	})

	it('breaks ties deterministically by id', () => {
		const a = buildObjectResponse({ id: 'b', metadata: { order: 1 } })
		const b = buildObjectResponse({ id: 'a', metadata: { order: 1 } })
		const sorted = sortBetsByOrder([a, b])
		expect(sorted.map((bet) => bet.id)).toEqual(['a', 'b'])
	})

	it('mixes metadata.order and createdAt seeds with newer createdAt floating up', () => {
		const dragged = buildObjectResponse({
			id: 'dragged',
			metadata: { order: Date.parse('2025-01-01T00:00:00Z') },
		})
		const newer = buildObjectResponse({
			id: 'newer',
			metadata: null,
			createdAt: '2026-04-26T00:00:00Z',
		})
		const sorted = sortBetsByOrder([dragged, newer])
		expect(sorted[0].id).toBe('newer')
	})
})

describe('computeNewOrderForInsert', () => {
	it('returns a positive value when inserting into an empty column', () => {
		expect(computeNewOrderForInsert([], 0)).toBeGreaterThan(0)
	})

	it('drops above the current top when inserting at index 0', () => {
		const top = buildObjectResponse({ id: 'top', metadata: { order: 100 } })
		const next = computeNewOrderForInsert([top], 0)
		expect(next).toBeGreaterThan(100)
	})

	it('drops below the current bottom when inserting at the end', () => {
		const top = buildObjectResponse({ id: 'top', metadata: { order: 100 } })
		const bottom = buildObjectResponse({ id: 'bottom', metadata: { order: 50 } })
		const next = computeNewOrderForInsert([top, bottom], 2)
		expect(next).toBeLessThan(50)
	})

	it('uses midpoint between neighbors for middle insertion', () => {
		const a = buildObjectResponse({ id: 'a', metadata: { order: 100 } })
		const b = buildObjectResponse({ id: 'b', metadata: { order: 50 } })
		const next = computeNewOrderForInsert([a, b], 1)
		expect(next).toBe(75)
	})

	it('clamps target index out of bounds to the valid range', () => {
		const a = buildObjectResponse({ id: 'a', metadata: { order: 10 } })
		const negative = computeNewOrderForInsert([a], -5)
		const huge = computeNewOrderForInsert([a], 999)
		expect(negative).toBeGreaterThan(10)
		expect(huge).toBeLessThan(10)
	})
})
