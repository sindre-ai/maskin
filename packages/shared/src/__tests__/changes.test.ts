import { describe, expect, it } from 'vitest'
import {
	OBJECT_DIFF_FIELDS,
	changesFromSnapshot,
	computeChanges,
	findChange,
	getChangesFromEventData,
	readChanges,
	reversePatch,
} from '../events/changes'

describe('computeChanges', () => {
	it('returns one entry per changed whitelisted field', () => {
		const prev = { title: 'old', status: 'signal', content: 'same' }
		const next = { title: 'new', status: 'active', content: 'same' }
		const changes = computeChanges(prev, next, OBJECT_DIFF_FIELDS)
		expect(changes).toEqual([
			{ field: 'status', old: 'signal', new: 'active' },
			{ field: 'title', old: 'old', new: 'new' },
		])
	})

	it('returns an empty array when no whitelisted field changed', () => {
		const prev = { title: 'same', status: 'signal', id: 'a' }
		const next = { title: 'same', status: 'signal', id: 'b' }
		expect(computeChanges(prev, next, OBJECT_DIFF_FIELDS)).toEqual([])
	})

	it('deep-compares object-valued fields (metadata)', () => {
		const prev = { metadata: { priority: 'low' } }
		const next = { metadata: { priority: 'low' } }
		expect(computeChanges(prev, next, ['metadata'])).toEqual([])
	})

	it('flags a metadata change when a sub-key differs', () => {
		const prev = { metadata: { priority: 'low' } }
		const next = { metadata: { priority: 'high' } }
		const changes = computeChanges(prev, next, ['metadata'])
		expect(changes).toEqual([
			{ field: 'metadata', old: { priority: 'low' }, new: { priority: 'high' } },
		])
	})

	it('treats null/undefined as equal for change detection', () => {
		const prev = { driver: null, status: 'signal' } as Record<string, unknown>
		const next = { driver: undefined, status: 'signal' } as Record<string, unknown>
		expect(computeChanges(prev, next, ['driver', 'status'])).toEqual([])
	})
})

describe('readChanges', () => {
	it('reads a valid changes array', () => {
		const data = { changes: [{ field: 'status', old: 'a', new: 'b' }] }
		expect(readChanges(data)).toEqual([{ field: 'status', old: 'a', new: 'b' }])
	})

	it('returns null when data has no changes key', () => {
		expect(readChanges({ previous: {}, updated: {} })).toBeNull()
	})

	it('returns null when data is null', () => {
		expect(readChanges(null)).toBeNull()
	})

	it('drops entries without a string field', () => {
		const data = {
			changes: [{ field: 'status', old: 'a', new: 'b' }, { old: 'x', new: 'y' }, null],
		}
		expect(readChanges(data)).toEqual([{ field: 'status', old: 'a', new: 'b' }])
	})
})

describe('changesFromSnapshot', () => {
	it('derives changes from legacy {previous, updated} data', () => {
		const data = {
			previous: { status: 'signal', title: 'Old' },
			updated: { status: 'active', title: 'Old' },
		}
		expect(changesFromSnapshot(data, OBJECT_DIFF_FIELDS)).toEqual([
			{ field: 'status', old: 'signal', new: 'active' },
		])
	})

	it('returns null when data lacks legacy previous/updated', () => {
		expect(changesFromSnapshot({ changes: [] }, OBJECT_DIFF_FIELDS)).toBeNull()
	})
})

describe('getChangesFromEventData', () => {
	it('prefers new-shape changes over legacy snapshot when both are present', () => {
		const data = {
			changes: [{ field: 'status', old: 'signal', new: 'active' }],
			previous: { status: 'other' },
			updated: { status: 'other' },
		}
		expect(getChangesFromEventData(data, OBJECT_DIFF_FIELDS)).toEqual([
			{ field: 'status', old: 'signal', new: 'active' },
		])
	})

	it('falls back to legacy snapshot when changes is absent', () => {
		const data = {
			previous: { status: 'signal' },
			updated: { status: 'active' },
		}
		expect(getChangesFromEventData(data, OBJECT_DIFF_FIELDS)).toEqual([
			{ field: 'status', old: 'signal', new: 'active' },
		])
	})

	it('returns null when neither shape is present', () => {
		expect(getChangesFromEventData({ unrelated: 1 }, OBJECT_DIFF_FIELDS)).toBeNull()
	})
})

describe('findChange', () => {
	it('finds a change by field name', () => {
		const changes = [
			{ field: 'status', old: 'a', new: 'b' },
			{ field: 'title', old: 'x', new: 'y' },
		]
		expect(findChange(changes, 'title')).toEqual({ field: 'title', old: 'x', new: 'y' })
	})

	it('returns undefined when the field is absent', () => {
		expect(findChange([{ field: 'status', old: 'a', new: 'b' }], 'driver')).toBeUndefined()
	})

	it('handles a null changes list', () => {
		expect(findChange(null, 'status')).toBeUndefined()
	})
})

describe('reversePatch', () => {
	it('rewinds each changed field to its old value', () => {
		const current = { status: 'active', title: 'New', unchanged: 42 }
		const changes = [
			{ field: 'status', old: 'signal', new: 'active' },
			{ field: 'title', old: 'Old', new: 'New' },
		]
		expect(reversePatch(current, changes)).toEqual({
			status: 'signal',
			title: 'Old',
			unchanged: 42,
		})
	})

	it('returns a shallow clone even when there are no changes', () => {
		const current = { status: 'active' }
		const result = reversePatch(current, [])
		expect(result).toEqual({ status: 'active' })
		expect(result).not.toBe(current)
	})
})
