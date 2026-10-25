import { describeObjectProperties } from '@/lib/object-properties'
import { describe, expect, it } from 'vitest'

describe('describeObjectProperties', () => {
	it('names the channel first, then short values', () => {
		expect(
			describeObjectProperties({
				source: 'sales_conversation',
				priority: 'P1',
				channel: 'linkedin_dm',
				pending_draft: null,
			}),
		).toEqual(['LinkedIn message', 'P1'])
	})

	it('reads an unknown channel as its own words', () => {
		expect(describeObjectProperties({ channel: 'carrier_pigeon' })).toEqual(['Carrier pigeon'])
	})

	it('labels plain values and skips long text, lists, objects and internal keys', () => {
		expect(
			describeObjectProperties({
				account: 'Sebastian',
				notes: 'x'.repeat(200),
				tags: ['a'],
				nested: { a: 1 },
				_internal: 'hidden',
			}),
		).toEqual(['Account: Sebastian'])
	})

	it('is empty for no metadata', () => {
		expect(describeObjectProperties(null)).toEqual([])
		expect(describeObjectProperties([])).toEqual([])
	})
})
