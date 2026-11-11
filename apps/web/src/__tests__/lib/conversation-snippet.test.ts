import type { ConversationListItemResponse } from '@/lib/api'
import { foldName, sameName, shortActorName, snippetAuthorLabel } from '@/lib/conversation-snippet'
import { describe, expect, it } from 'vitest'

type Participant = ConversationListItemResponse['participants'][number]

function person(actorId: string, actorName: string, actorType: 'human' | 'agent'): Participant {
	return { actorId, actorName, actorType, joinedAt: null, addedBy: null }
}

const me = person('me', 'Me', 'human')
const bookkeeper = person('bk', 'Bookkeeper', 'agent')
const relay = person('relay', 'Relay', 'agent')
const sam = person('sam', 'Sam', 'human')

function chat(
	participants: Participant[],
	by: { id: string; name: string } | null = { id: 'bk', name: 'Bookkeeper' },
) {
	return {
		participants,
		snippet_actor_id: by?.id ?? null,
		snippet_actor_name: by?.name ?? null,
	}
}

// The same table is in the Swift tests (NameMatchTests). Keep the two in step.
const NAME_CASES: Array<[string, string, boolean]> = [
	['José', 'jose', true],
	['Straße', 'STRASSE', true],
	['İlker', 'ilker', true],
	['  Bookkeeper ', 'bookkeeper', true],
	['Bookkeeper', 'Bookkeeper 2', false],
	['Zoë', 'Zoe Lee', false],
]

describe('sameName', () => {
	it.each(NAME_CASES)('compares %j with %j as %s', (a, b, expected) => {
		expect(sameName(a, b)).toBe(expected)
	})

	it('folds a name to the same text the iOS side does', () => {
		expect(foldName(' Straße ')).toBe('strasse')
		expect(foldName('İlker')).toBe('ilker')
		expect(foldName('José')).toBe('jose')
	})
})

describe('snippetAuthorLabel', () => {
	it('keeps the name when the displayed title is a custom one', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper]), 'Q3 planning', 'me')).toBe('Bookkeeper')
	})

	it('drops the name when the displayed title is the author, folded', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper]), 'Bookkeeper', 'me')).toBeNull()
		expect(snippetAuthorLabel(chat([me, bookkeeper]), '  bookkeeper ', 'me')).toBeNull()
	})

	it('compares with what the row displays, not with another title', () => {
		// The stored title is custom, but this row displays the person's name: drop it.
		expect(snippetAuthorLabel(chat([me, bookkeeper]), 'Bookkeeper', 'me')).toBeNull()
		// The stored title is the person's name, but this row displays a custom one: keep it.
		expect(snippetAuthorLabel(chat([me, bookkeeper]), 'Month-end close', 'me')).toBe('Bookkeeper')
	})

	it('keeps the name with three or more people, even when the title matches', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper, relay]), 'Bookkeeper', 'me')).toBe('Bookkeeper')
	})

	it('reads You for the viewer own message, whatever the title', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper], { id: 'me', name: 'Me' }), 'Me', 'me')).toBe(
			'You',
		)
	})

	it('keeps the name when the participant list is empty', () => {
		expect(snippetAuthorLabel(chat([]), 'Bookkeeper', 'me')).toBe('Bookkeeper')
	})

	it('keeps the name when the list leaves the viewer out, even with two people', () => {
		expect(snippetAuthorLabel(chat([bookkeeper, sam]), 'Bookkeeper', 'me')).toBe('Bookkeeper')
	})

	it('keeps the name when the viewer is unknown', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper]), 'Bookkeeper', undefined)).toBe('Bookkeeper')
	})

	it('says nothing when nobody wrote the latest message', () => {
		expect(snippetAuthorLabel(chat([me, bookkeeper], null), 'Bookkeeper', 'me')).toBeNull()
	})

	// Same case as `nameWithoutAuthorIDKeepsName` in the Swift tests.
	it('keeps a name that arrives without an author id', () => {
		const noId = {
			participants: [me, bookkeeper],
			snippet_actor_id: null,
			snippet_actor_name: 'Bookkeeper',
		}
		expect(snippetAuthorLabel(noId, 'Q3 planning', 'me')).toBe('Bookkeeper')
	})
})

describe('shortActorName', () => {
	it('cuts a name of three or more words to its initials, small words in lower case', () => {
		expect(shortActorName('Chief of Staff')).toBe('CoS')
		expect(shortActorName('Head Of Growth')).toBe('HOG')
	})

	it('leaves one- and two-word names whole', () => {
		expect(shortActorName('Billing Agent')).toBe('Billing Agent')
		expect(shortActorName('Strategist')).toBe('Strategist')
		expect(shortActorName('  Quill ')).toBe('Quill')
	})
})
