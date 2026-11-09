import type { ConversationListItemResponse } from '@/lib/api'
import { snippetAuthorLabel } from '@/lib/conversation-snippet'
import { describe, expect, it } from 'vitest'

type Participant = ConversationListItemResponse['participants'][number]

function person(actorId: string, actorName: string, actorType: 'human' | 'agent'): Participant {
	return { actorId, actorName, actorType, joinedAt: null, addedBy: null }
}

const me = person('me', 'Me', 'human')
const bookkeeper = person('bk', 'Bookkeeper', 'agent')
const relay = person('relay', 'Relay', 'agent')

function chat(
	title: string,
	participants: Participant[],
	by: { id: string; name: string } | null = { id: 'bk', name: 'Bookkeeper' },
) {
	return {
		title,
		participants,
		snippet_actor_id: by?.id ?? null,
		snippet_actor_name: by?.name ?? null,
	}
}

describe('snippetAuthorLabel', () => {
	it('keeps the name in a custom-titled one-to-one chat', () => {
		expect(snippetAuthorLabel(chat('Q3 planning', [me, bookkeeper]), 'me')).toBe('Bookkeeper')
	})

	it('drops the name when the title is the one who wrote it, ignoring case and spaces', () => {
		expect(snippetAuthorLabel(chat('Bookkeeper', [me, bookkeeper]), 'me')).toBeNull()
		expect(snippetAuthorLabel(chat('  bookkeeper ', [me, bookkeeper]), 'me')).toBeNull()
	})

	it('keeps the name with three or more people, even when the title matches', () => {
		expect(snippetAuthorLabel(chat('Bookkeeper', [me, bookkeeper, relay]), 'me')).toBe('Bookkeeper')
	})

	it('still reads You for the viewer own message', () => {
		expect(snippetAuthorLabel(chat('Me', [me, bookkeeper], { id: 'me', name: 'Me' }), 'me')).toBe(
			'You',
		)
	})

	it('keeps the name when the participant list is empty rather than guessing a one-to-one', () => {
		expect(snippetAuthorLabel(chat('Bookkeeper', []), 'me')).toBe('Bookkeeper')
	})

	it('says nothing when nobody wrote the latest message', () => {
		expect(snippetAuthorLabel(chat('Bookkeeper', [me, bookkeeper], null), 'me')).toBeNull()
	})
})
