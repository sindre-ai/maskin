import type { ConversationListItemResponse } from '@/lib/api'
import { groupConversations, startOfDay } from '@/lib/conversation-groups'
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
})
