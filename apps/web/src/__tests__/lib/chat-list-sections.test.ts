import type { ChatSectionResponse, ConversationListItemResponse } from '@/lib/api'
import {
	badgeCount,
	daysQuiet,
	groupWithSections,
	hasQuietNews,
	sectionIdOfGroup,
	unlistedChats,
	viewReason,
	waitingCount,
} from '@/lib/chat-list-sections'
import { describe, expect, it } from 'vitest'

const SELF = 'actor-me'
const NOW = new Date('2026-11-14T12:00:00.000Z')

function actor(id: string, type: 'human' | 'agent' = 'agent') {
	return { actorId: id, actorName: `Name ${id}`, actorType: type, joinedAt: null, addedBy: null }
}

function chat(
	id: string,
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
	return {
		id,
		workspaceId: 'ws-1',
		title: `Title ${id}`,
		createdBy: SELF,
		lastMessageAt: '2026-11-13T09:00:00.000Z',
		createdAt: '2026-11-01T09:00:00.000Z',
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: 'hi',
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [actor(SELF, 'human'), actor(`agent-${id}`)],
		...overrides,
	}
}

function section(
	id: string,
	conversationIds: string[],
	position = 0,
	name = id,
): ChatSectionResponse {
	return { id, name, position, collapsed: false, conversationIds }
}

describe('waiting counts', () => {
	it('adds mentions and open cards, and leaves new messages out', () => {
		const c = chat('a', { unread_count: 9, mentions_unread: 2, open_cards: 1 })
		expect(waitingCount(c)).toBe(3)
		expect(badgeCount(c)).toBe(3)
	})

	it('shows the hollow dot for new messages with nothing for the viewer', () => {
		const c = chat('a', { unread_count: 4, mentions_unread: 0, open_cards: 0 })
		expect(badgeCount(c)).toBe(0)
		expect(hasQuietNews(c)).toBe(true)
	})

	it('still counts every message in a direct chat with an agent', () => {
		const c = chat('a', { directPairKey: 'pair', unread_count: 4 })
		expect(badgeCount(c)).toBe(4)
		expect(hasQuietNews(c)).toBe(false)
	})
})

describe('viewReason', () => {
	it('says why a chat waits, mentions before cards', () => {
		expect(viewReason('waiting', chat('a', { mentions_unread: 1, card_text: 'ok?' }))).toBe(
			'Mentions you: "ok?"',
		)
		expect(viewReason('waiting', chat('a', { open_cards: 1, card_text: 'Allow Gmail?' }))).toBe(
			'Asks you: "Allow Gmail?"',
		)
		expect(viewReason('waiting', chat('a', { open_cards: 1 }))).toBe('Asks you')
	})

	it('names a running chat and how long a quiet one has been quiet', () => {
		expect(viewReason('running', chat('a'))).toBe('Agent running now')
		const quiet = chat('a', { lastMessageAt: '2026-11-04T12:00:00.000Z' })
		expect(daysQuiet(quiet, NOW)).toBe(10)
		expect(viewReason('quiet', quiet, NOW)).toBe('Last message 10 days ago')
		expect(viewReason('quiet', chat('b', { lastMessageAt: '2026-11-13T11:00:00.000Z' }), NOW)).toBe(
			'Last message 0 days ago',
		)
	})
})

describe('groupWithSections', () => {
	const chats = [
		chat('one'),
		chat('two', { pinned: true }),
		chat('three'),
		chat('room', { roomKind: 'free' }),
	]

	it('puts Pinned, then sections in order, then Rooms and Agents', () => {
		const groups = groupWithSections(
			chats,
			[section('s2', ['three'], 1), section('s1', [], 0)],
			SELF,
			NOW,
		)
		expect(groups.map((g) => g.key)).toEqual([
			'pinned',
			'section:s1',
			'section:s2',
			'rooms',
			'agents',
		])
		expect(groups.find((g) => g.key === 'section:s2')?.items.map((c) => c.id)).toEqual(['three'])
	})

	it('keeps an empty section so it can take a drop', () => {
		const groups = groupWithSections(chats, [section('s1', [])], SELF, NOW)
		expect(groups.find((g) => g.key === 'section:s1')?.items).toEqual([])
	})

	it('shows a sectioned chat once, in its section, pin glyph or not, and pinned first inside', () => {
		const groups = groupWithSections(chats, [section('s1', ['one', 'two'])], SELF, NOW)
		expect(groups.find((g) => g.key === 'pinned')).toBeUndefined()
		expect(groups.find((g) => g.key === 'section:s1')?.items.map((c) => c.id)).toEqual([
			'two',
			'one',
		])
		const ids = groups.flatMap((g) => [
			...g.items.map((c) => c.id),
			...(g.entries ?? []).flatMap((e) =>
				e.kind === 'agent' ? e.conversations.map((c) => c.id) : [],
			),
		])
		expect(ids.filter((id) => id === 'one')).toHaveLength(1)
	})

	it('lists a chat in the first section that names it', () => {
		const groups = groupWithSections(
			[chat('one')],
			[section('s1', ['one'], 0), section('s2', ['one'], 1)],
			SELF,
			NOW,
		)
		expect(groups.find((g) => g.key === 'section:s2')?.items).toEqual([])
	})

	it('drops a section chat that is not loaded without an error', () => {
		const groups = groupWithSections([chat('one')], [section('s1', ['gone'])], SELF, NOW)
		expect(groups.find((g) => g.key === 'section:s1')?.items).toEqual([])
	})

	it('leaves no chat out of every view', () => {
		const groups = groupWithSections(chats, [section('s1', ['one'])], SELF, NOW)
		expect(unlistedChats(chats, groups)).toEqual([])
	})
})

describe('sectionIdOfGroup', () => {
	it('reads a section back from its group key and ignores the others', () => {
		expect(sectionIdOfGroup('section:abc')).toBe('abc')
		expect(sectionIdOfGroup('agents')).toBeNull()
	})
})
