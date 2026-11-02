import type { RelationshipResponse } from '@/lib/api'
import { findFlowId, readDue } from '@/lib/object-detail-meta'

describe('findFlowId', () => {
	it('returns the source of the in_loop edge that targets the item', () => {
		const rels = [
			{ type: 'relates_to', sourceId: 'x', targetId: 'item' },
			{ type: 'in_loop', sourceId: 'flow-1', targetId: 'item' },
		] as RelationshipResponse[]
		expect(findFlowId(rels, 'item')).toBe('flow-1')
	})

	it('returns undefined when the item is in no flow', () => {
		expect(findFlowId([], 'item')).toBeUndefined()
		expect(findFlowId(undefined, 'item')).toBeUndefined()
	})
})

describe('readDue', () => {
	it('returns undefined when no due field exists', () => {
		expect(readDue({ metadata: null })).toBeUndefined()
		expect(readDue({ metadata: { other: 'x' } })).toBeUndefined()
		expect(readDue({ metadata: { due: '  ' } })).toBeUndefined()
	})

	it('returns a formatted date for a parseable due value', () => {
		expect(readDue({ metadata: { due_date: '2026-11-20' } })).toMatch(/20/)
	})

	it('returns the raw text when the due value is not a date', () => {
		expect(readDue({ metadata: { due: 'next sprint' } })).toBe('next sprint')
	})
})
