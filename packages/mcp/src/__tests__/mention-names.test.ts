import { describe, expect, it } from 'vitest'
import { resolveMentionNames } from '../mention-names'

const participants = [
	{ actorId: 'a1', actorName: 'Magnus Hansen' },
	{ actorId: 'a2', actorName: 'Chief of Staff' },
	{ actorId: 'a3', actorName: 'Magnus Berg' },
	{ actorId: 'a4', actorName: 'Strategist' },
]

describe('resolveMentionNames', () => {
	it('resolves an exact name case-insensitively and ignores a leading @', () => {
		expect(resolveMentionNames(['@strategist'], participants)).toEqual({
			resolved: ['a4'],
			unresolved: [],
		})
	})

	it('resolves a unique first name', () => {
		expect(resolveMentionNames(['Chief'], participants).resolved).toEqual(['a2'])
	})

	it('reports a first name shared by two participants as ambiguous', () => {
		expect(resolveMentionNames(['Magnus'], participants)).toEqual({
			resolved: [],
			unresolved: [{ name: 'Magnus', reason: 'ambiguous' }],
		})
	})

	it('reports a name nobody in the conversation has', () => {
		expect(resolveMentionNames(['Nobody'], participants).unresolved).toEqual([
			{ name: 'Nobody', reason: 'not_in_conversation' },
		])
	})

	it('dedupes repeated names', () => {
		expect(resolveMentionNames(['Strategist', '@Strategist'], participants).resolved).toEqual([
			'a4',
		])
	})
})
