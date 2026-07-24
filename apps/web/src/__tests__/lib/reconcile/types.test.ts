import { extractTheirsFrom409 } from '@/lib/reconcile/types'
import { describe, expect, it } from 'vitest'

describe('extractTheirsFrom409', () => {
	it('extracts the current object from a real 409 body', () => {
		const body = {
			error: { code: 'CONFLICT', message: 'stale' },
			current: { id: 'o1', type: 'bet', content: 'X', version: 4 },
		}
		const theirs = extractTheirsFrom409(body)
		expect(theirs?.id).toBe('o1')
		expect(theirs?.version).toBe(4)
	})

	it('returns null for the pre-fix nested-object shape', () => {
		const body = {
			error: { code: 'CONFLICT', message: 'stale' },
			object: { id: 'o1', type: 'bet', content: 'X', version: 4 },
		}
		expect(extractTheirsFrom409(body)).toBeNull()
	})

	it('returns null for a bare object payload (not the wire shape)', () => {
		const body = { id: 'o2', type: 'task', content: 'Y', version: 7 }
		expect(extractTheirsFrom409(body)).toBeNull()
	})

	it('returns null when neither shape matches', () => {
		expect(extractTheirsFrom409({ error: 'stale' })).toBeNull()
		expect(extractTheirsFrom409({ current: null })).toBeNull()
		expect(extractTheirsFrom409({ current: { id: 42 } })).toBeNull()
		expect(extractTheirsFrom409(null)).toBeNull()
		expect(extractTheirsFrom409(undefined)).toBeNull()
		expect(extractTheirsFrom409('string')).toBeNull()
	})
})
