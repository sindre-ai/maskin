import { extractTheirsFrom409 } from '@/lib/reconcile/types'
import { describe, expect, it } from 'vitest'

describe('extractTheirsFrom409', () => {
	it('extracts a nested object payload', () => {
		const body = {
			error: { code: 'CONFLICT', message: 'stale' },
			object: { id: 'o1', type: 'bet', content: 'X', version: 4 },
		}
		const theirs = extractTheirsFrom409(body)
		expect(theirs?.id).toBe('o1')
		expect(theirs?.version).toBe(4)
	})

	it('accepts a bare object payload', () => {
		const body = { id: 'o2', type: 'task', content: 'Y', version: 7 }
		const theirs = extractTheirsFrom409(body)
		expect(theirs?.id).toBe('o2')
		expect(theirs?.version).toBe(7)
	})

	it('returns null when neither shape matches', () => {
		expect(extractTheirsFrom409({ error: 'stale' })).toBeNull()
		expect(extractTheirsFrom409(null)).toBeNull()
		expect(extractTheirsFrom409(undefined)).toBeNull()
		expect(extractTheirsFrom409('string')).toBeNull()
	})
})
