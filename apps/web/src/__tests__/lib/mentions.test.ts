import { describe, expect, it } from 'vitest'

import type { ActorListItem } from '@/lib/api'
import { parseMentions } from '@/lib/mentions'

function buildActor(overrides: Partial<ActorListItem> = {}): ActorListItem {
	return {
		id: 'actor-1',
		name: 'Alice',
		type: 'human',
		isSystem: false,
		...overrides,
	} as ActorListItem
}

describe('parseMentions', () => {
	it('returns the actor id when @Name appears in the text', () => {
		const actors = [buildActor({ id: 'alice', name: 'Alice' })]
		expect(parseMentions('thanks @Alice for the update', actors)).toEqual(['alice'])
	})

	it('returns an empty array when no @Name matches', () => {
		const actors = [buildActor({ id: 'alice', name: 'Alice' })]
		expect(parseMentions('no mentions here', actors)).toEqual([])
	})

	it('matches multiple distinct actors mentioned in the same text', () => {
		const actors = [
			buildActor({ id: 'alice', name: 'Alice' }),
			buildActor({ id: 'bob', name: 'Bob' }),
		]
		expect(parseMentions('@Alice and @Bob please review', actors)).toEqual(['alice', 'bob'])
	})

	it('does not match a name that is only a substring without the @ prefix', () => {
		const actors = [buildActor({ id: 'alice', name: 'Alice' })]
		expect(parseMentions('Alice mentioned this earlier', actors)).toEqual([])
	})

	it('is the caller’s responsibility to exclude non-mentionable actors (e.g. system actors)', () => {
		const actors = [buildActor({ id: 'system-1', name: 'System', isSystem: true })]
		expect(parseMentions('hi @System', actors)).toEqual(['system-1'])
	})
})
