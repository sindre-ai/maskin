import type { ConversationListItemResponse } from '@/lib/api'
import { groupConversations, isRoomListed, startOfDay } from '@/lib/conversation-groups'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-03-12T10:00:00.000Z')

function daysAgo(days: number, hour = 9): string {
	const d = new Date(NOW)
	d.setDate(d.getDate() - days)
	d.setHours(hour, 0, 0, 0)
	return d.toISOString()
}

function buildConversation(
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
	return {
		id: `conv-${Math.random().toString(36).slice(2)}`,
		workspaceId: 'ws-1',
		title: 'Untitled',
		createdBy: 'actor-1',
		lastMessageAt: daysAgo(0),
		createdAt: daysAgo(0),
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: null,
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [],
		...overrides,
	}
}

describe('startOfDay', () => {
	it('returns local midnight for the given date', () => {
		const d = new Date(2026, 2, 12, 23, 45)
		expect(new Date(startOfDay(d)).getHours()).toBe(0)
		expect(new Date(startOfDay(d)).getDate()).toBe(12)
	})
})

describe('groupConversations', () => {
	it('returns no groups for an empty list', () => {
		expect(groupConversations([], { now: NOW })).toEqual([])
	})

	it('buckets into Pinned, Today, Yesterday, This week and Earlier in order', () => {
		const groups = groupConversations(
			[
				buildConversation({ title: 'old', lastMessageAt: daysAgo(30) }),
				buildConversation({ title: 'today', lastMessageAt: daysAgo(0) }),
				buildConversation({ title: 'pinned', pinned: true, lastMessageAt: daysAgo(90) }),
				buildConversation({ title: 'week', lastMessageAt: daysAgo(4) }),
				buildConversation({ title: 'yesterday', lastMessageAt: daysAgo(1) }),
			],
			{ now: NOW },
		)
		expect(groups.map((g) => g.label)).toEqual([
			'Pinned',
			'Today',
			'Yesterday',
			'This week',
			'Earlier',
		])
		expect(groups[0].items[0].title).toBe('pinned')
		expect(groups[4].items[0].title).toBe('old')
	})

	it('lists direct messages first, in their own group, by the marker and not the title', () => {
		const groups = groupConversations(
			[
				buildConversation({ title: 'today', lastMessageAt: daysAgo(0) }),
				buildConversation({ title: 'pinned', pinned: true, lastMessageAt: daysAgo(0) }),
				buildConversation({ title: 'Forge', lastMessageAt: daysAgo(40), directPairKey: 'a:b' }),
				// Titled like an agent but not marked: topical.
				buildConversation({ title: 'Relay', lastMessageAt: daysAgo(1) }),
			],
			{ now: NOW },
		)
		expect(groups.map((g) => g.label)).toEqual(['Direct messages', 'Pinned', 'Today', 'Yesterday'])
		expect(groups[0].items.map((c) => c.title)).toEqual(['Forge'])
		expect(groups[3].items.map((c) => c.title)).toEqual(['Relay'])
	})

	it('puts a direct message between two people in the direct group, named after the other person', () => {
		const person = { actorId: 'me', actorName: 'Ada', actorType: 'human' }
		const other = { actorId: 'bo', actorName: 'Bo', actorType: 'human' }
		const groups = groupConversations(
			[
				buildConversation({
					title: 'Bo',
					directPairKey: 'bo:me',
					participants: [person, other] as ConversationListItemResponse['participants'],
				}),
			],
			{ now: NOW },
		)
		expect(groups.map((g) => g.key)).toEqual(['direct'])
		expect(groups[0].items.map((c) => c.title)).toEqual(['Bo'])
	})

	it('keeps a pinned direct message in the direct group only', () => {
		const groups = groupConversations(
			[buildConversation({ title: 'Forge', pinned: true, directPairKey: 'a:b' })],
			{ now: NOW },
		)
		expect(groups.map((g) => g.key)).toEqual(['direct'])
	})

	it('lists direct messages first in the unread view too, and leaves them out of Unread and Earlier', () => {
		const groups = groupConversations(
			[
				buildConversation({ title: 'Forge', unread_count: 2, directPairKey: 'a:b' }),
				buildConversation({ title: 'topic', unread_count: 1 }),
				buildConversation({ title: 'quiet' }),
			],
			{ mode: 'unread', now: NOW },
		)
		expect(groups.map((g) => g.key)).toEqual(['direct', 'unread', 'earlier'])
		expect(groups[1].items.map((c) => c.title)).toEqual(['topic'])
		expect(groups[2].items.map((c) => c.title)).toEqual(['quiet'])
	})

	it('keeps the archived list flat, direct messages included', () => {
		const groups = groupConversations(
			[buildConversation({ directPairKey: 'a:b' }), buildConversation()],
			{ mode: 'archived', now: NOW },
		)
		expect(groups.map((g) => g.key)).toEqual(['archived'])
		expect(groups[0].items).toHaveLength(2)
	})

	it('omits groups that have no conversations', () => {
		const groups = groupConversations([buildConversation({ lastMessageAt: daysAgo(0) })], {
			now: NOW,
		})
		expect(groups.map((g) => g.label)).toEqual(['Today'])
	})

	it('crosses a day boundary — 23:59 yesterday is Yesterday, not Today', () => {
		const groups = groupConversations([buildConversation({ lastMessageAt: daysAgo(1, 23) })], {
			now: NOW,
		})
		expect(groups[0].label).toBe('Yesterday')
	})

	it('buckets a conversation from last year into Earlier', () => {
		const groups = groupConversations(
			[buildConversation({ lastMessageAt: new Date('2025-11-02T09:00:00.000Z').toISOString() })],
			{ now: NOW },
		)
		expect(groups[0].label).toBe('Earlier')
	})

	it('falls back to createdAt when the conversation has no messages', () => {
		const groups = groupConversations(
			[buildConversation({ lastMessageAt: null, createdAt: daysAgo(0) })],
			{ now: NOW },
		)
		expect(groups[0].label).toBe('Today')
	})

	it('puts a conversation with no usable timestamp into Earlier rather than dropping it', () => {
		const groups = groupConversations(
			[buildConversation({ lastMessageAt: null, createdAt: null })],
			{ now: NOW },
		)
		expect(groups[0].label).toBe('Earlier')
		expect(groups[0].items).toHaveLength(1)
	})

	it('collapses everything into one Archived group in archived mode', () => {
		const groups = groupConversations(
			[
				buildConversation({ lastMessageAt: daysAgo(0) }),
				buildConversation({ pinned: true, lastMessageAt: daysAgo(40) }),
			],
			{ mode: 'archived', now: NOW },
		)
		expect(groups).toHaveLength(1)
		expect(groups[0].label).toBe('Archived')
		expect(groups[0].items).toHaveLength(2)
	})

	it('labels search mode with the result count', () => {
		expect(groupConversations([buildConversation()], { mode: 'search', now: NOW })[0].label).toBe(
			'1 result',
		)
		expect(
			groupConversations([buildConversation(), buildConversation()], {
				mode: 'search',
				now: NOW,
			})[0].label,
		).toBe('2 results')
	})

	it('splits unread mode into Pinned, Unread and Earlier and drops empty groups', () => {
		const groups = groupConversations(
			[
				buildConversation({ id: 'p', pinned: true }),
				buildConversation({ id: 'u', unread_count: 2 }),
				buildConversation({ id: 'e' }),
			],
			{ mode: 'unread', now: NOW },
		)
		expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
			['Pinned', ['p']],
			['Unread', ['u']],
			['Earlier', ['e']],
		])
		expect(
			groupConversations([buildConversation()], { mode: 'unread', now: NOW }).map((g) => g.label),
		).toEqual(['Earlier'])
	})
})

describe('rooms', () => {
	const room = (overrides: Partial<ConversationListItemResponse>) =>
		buildConversation({ snippet: 'hello', ...overrides })

	it('puts rooms in a Rooms group above everything else, each chat once', () => {
		const groups = groupConversations(
			[
				buildConversation({ id: 'dm', directPairKey: 'a:b' }),
				room({ id: 'free', roomKind: 'free', pinned: true }),
				buildConversation({ id: 'plain' }),
			],
			{ mode: 'unread', now: NOW },
		)
		expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
			['Rooms', ['free']],
			['Direct messages', ['dm']],
			['Earlier', ['plain']],
		])
		const dated = groupConversations([room({ id: 'free', roomKind: 'free' })], { now: NOW })
		expect(dated.map((g) => g.label)).toEqual(['Rooms'])
	})

	it('always lists a free-form room, however quiet or empty', () => {
		const quiet = room({ roomKind: 'free', lastMessageAt: daysAgo(200), snippet: null })
		expect(isRoomListed(quiet, NOW)).toBe(true)
	})

	it('lists a flow room with a message in the last 14 days', () => {
		expect(isRoomListed(room({ roomKind: 'flow', lastMessageAt: daysAgo(13) }), NOW)).toBe(true)
		expect(isRoomListed(room({ roomKind: 'flow', lastMessageAt: daysAgo(15) }), NOW)).toBe(false)
	})

	it('lists a quiet flow room when it is unread, pinned or working', () => {
		const quiet = { roomKind: 'flow' as const, lastMessageAt: daysAgo(60) }
		expect(isRoomListed(room({ ...quiet, unread_count: 1 }), NOW)).toBe(true)
		expect(isRoomListed(room({ ...quiet, pinned: true }), NOW)).toBe(true)
		expect(isRoomListed(room({ ...quiet, working_actor_ids: ['agent-1'] }), NOW)).toBe(true)
	})

	it('hides a flow room with no messages, like an empty direct message', () => {
		const empty = room({ roomKind: 'flow', snippet: null, pinned: true, lastMessageAt: daysAgo(0) })
		expect(isRoomListed(empty, NOW)).toBe(false)
		const groups = groupConversations([empty], { mode: 'unread', now: NOW })
		expect(groups).toEqual([])
	})

	it('does not treat an ordinary chat as a room', () => {
		expect(isRoomListed(buildConversation(), NOW)).toBe(false)
	})
})
