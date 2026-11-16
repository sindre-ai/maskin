import type { ConversationListItemResponse } from '@/lib/api'
import {
	groupChats,
	matchesPill,
	operatorBeingTyped,
	pillCounts,
	previewMarker,
	searchOperatorsUsed,
	trackedMarker,
} from '@/lib/chat-list-v2'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-11-16T12:00:00')

function chat(overrides: Partial<ConversationListItemResponse> = {}): ConversationListItemResponse {
	return {
		id: 'c1',
		workspaceId: 'ws',
		title: 'Chat',
		createdBy: 'me',
		lastMessageAt: '2026-11-16T09:00:00',
		createdAt: '2026-11-01T09:00:00',
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: null,
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [
			{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
			{ actorId: 'a1', actorName: 'Forge', actorType: 'agent', joinedAt: null, addedBy: null },
		],
		...overrides,
	}
}

describe('previewMarker', () => {
	it('puts error before needs you before working, and never two', () => {
		const working = [{ agent_id: 'a1', session_id: 's1' }]
		expect(previewMarker(chat({ working }))).toBe('working')
		expect(previewMarker(chat({ working, needs_you: true }))).toBe('needs_you')
		expect(
			previewMarker(chat({ working, needs_you: true, error: { reason: 'other', message_id: 4 } })),
		).toBe('error')
		expect(previewMarker(chat())).toBe('none')
	})

	it('reads an older server (no new fields) as no marker', () => {
		expect(previewMarker(chat())).toBe('none')
		expect(matchesPill(chat(), 'needs_you')).toBe(false)
	})
})

describe('trackedMarker', () => {
	it('falls back to unread, then later, then none', () => {
		expect(trackedMarker(chat({ unread_count: 2 }))).toBe('unread')
		expect(trackedMarker(chat({ later: true }))).toBe('later')
		expect(trackedMarker(chat())).toBe('none')
		expect(trackedMarker(chat({ unread_count: 1, needs_you: true }))).toBe('needs_you')
	})
})

describe('pills', () => {
	const rows = [
		chat({ id: 'a', needs_you: true }),
		chat({ id: 'b', error: { reason: 'usage_limit', message_id: 9 } }),
		chat({ id: 'c', unread_count: 3 }),
		chat({ id: 'd', working: [{ agent_id: 'a1', session_id: 's1' }] }),
		chat({ id: 'e', later: true, unread_count: 1, needs_you: true }),
		chat({ id: 'f' }),
	]

	it('counts an error chat under Needs you and keeps Later chats out of every other pill', () => {
		expect(pillCounts(rows)).toEqual({ all: 5, needs_you: 2, unread: 1, working: 1, later: 1 })
	})

	it('lists a Later chat only under Later', () => {
		const later = rows.filter((c) => matchesPill(c, 'later')).map((c) => c.id)
		expect(later).toEqual(['e'])
		expect(rows.filter((c) => matchesPill(c, 'needs_you')).map((c) => c.id)).toEqual(['a', 'b'])
	})
})

describe('groupChats', () => {
	it('groups by date as Pinned, Today, Yesterday, Earlier with the unparseable time in Earlier', () => {
		const groups = groupChats(
			[
				chat({ id: 'p', pinned: true }),
				chat({ id: 't' }),
				chat({ id: 'y', lastMessageAt: '2026-11-15T23:00:00' }),
				chat({ id: 'e', lastMessageAt: '2026-11-01T10:00:00' }),
				chat({ id: 'x', lastMessageAt: null, createdAt: null }),
			],
			'date',
			{ now: NOW },
		)
		expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
			['Pinned', ['p']],
			['Today', ['t']],
			['Yesterday', ['y']],
			['Earlier', ['e', 'x']],
		])
	})

	it('puts stopped chats first in Needs you under Group by Status', () => {
		const groups = groupChats(
			[
				chat({ id: 'ask', needs_you: true }),
				chat({ id: 'stopped', error: { reason: 'connection', message_id: 1 } }),
				chat({ id: 'quiet' }),
				chat({ id: 'new', unread_count: 1 }),
			],
			'status',
			{ now: NOW },
		)
		expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
			['Needs you', ['stopped', 'ask']],
			['Unread', ['new']],
			['Earlier', ['quiet']],
		])
	})

	it('groups by type as Direct, Topic, Group', () => {
		const groups = groupChats(
			[
				chat({ id: 'dm', directPairKey: 'a:b' }),
				chat({ id: 'topic' }),
				chat({
					id: 'grp',
					participants: [
						...chat().participants,
						{ actorId: 'a2', actorName: 'Sage', actorType: 'agent', joinedAt: null, addedBy: null },
					],
				}),
			],
			'type',
			{ now: NOW, viewerId: 'me' },
		)
		expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
			['Direct', ['dm']],
			['Topic', ['topic']],
			['Group', ['grp']],
		])
	})

	it('groups by agent and by tag, one group per chat, the unnamed last', () => {
		const rows = [
			chat({ id: '1', tags: ['growth'] }),
			chat({ id: '2', tags: [] }),
			chat({ id: '3', tags: ['growth', 'ops'] }),
		]
		expect(
			groupChats(rows, 'tag', { viewerId: 'me' }).map((g) => [g.label, g.items.length]),
		).toEqual([
			['growth', 2],
			['No tag', 1],
		])
		expect(
			groupChats(rows, 'agent', { viewerId: 'me' }).map((g) => [g.label, g.items.length]),
		).toEqual([['Forge', 3]])
	})

	it('gives Group by None one group with no heading', () => {
		const groups = groupChats([chat()], 'none')
		expect(groups).toHaveLength(1)
		expect(groups[0].label).toBe('')
	})
})

describe('search operators', () => {
	it('lists each operator used once and never the words after it', () => {
		expect(searchOperatorsUsed('from:forge is:unread is:later')).toEqual(['from', 'is'])
		expect(searchOperatorsUsed('@forge team:growth "launch plan" -draft')).toEqual([
			'phrase',
			'agent',
			'team',
			'exclude',
		])
		expect(searchOperatorsUsed('with:sage')).toEqual(['with'])
	})

	it('reads plain words, a lone dash and a dash inside a word as no operator', () => {
		expect(searchOperatorsUsed('billing retries')).toEqual([])
		expect(searchOperatorsUsed('e-mail - draft')).toEqual([])
	})

	it('finds the operator being typed at the end of the text', () => {
		expect(operatorBeingTyped('billing is:un')).toEqual({ operator: 'is', partial: 'un', start: 8 })
		expect(operatorBeingTyped('@fo')).toEqual({ operator: 'agent', partial: 'fo', start: 0 })
		expect(operatorBeingTyped('from:forge ')).toBeNull()
		expect(operatorBeingTyped('billing')).toBeNull()
	})
})
