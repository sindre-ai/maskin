import type { ConversationListItemResponse } from '@/lib/api'
import { agentOf, buildAgentEntries, groupByAgent } from '@/lib/conversation-agent-rows'
import { describe, expect, it } from 'vitest'

const SELF = 'actor-me'

function actor(id: string, type: 'human' | 'agent' = 'agent') {
	return { actorId: id, actorName: `Name ${id}`, actorType: type, joinedAt: null, addedBy: null }
}

function chat(
	id: string,
	others: Array<ReturnType<typeof actor>>,
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
	return {
		id,
		workspaceId: 'ws-1',
		title: `Title ${id}`,
		createdBy: SELF,
		lastMessageAt: '2026-03-12T09:00:00.000Z',
		createdAt: '2026-03-01T09:00:00.000Z',
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: null,
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [actor(SELF, 'human'), ...others],
		...overrides,
	}
}

describe('agentOf', () => {
	it('names the one agent in a chat with the viewer', () => {
		expect(agentOf(chat('a', [actor('cto')]), SELF)?.actorId).toBe('cto')
	})

	it('finds no agent in a chat with a person, a group or nobody', () => {
		expect(agentOf(chat('a', [actor('sam', 'human')]), SELF)).toBeNull()
		expect(agentOf(chat('b', [actor('cto'), actor('cpo')]), SELF)).toBeNull()
		expect(agentOf(chat('c', []), SELF)).toBeNull()
	})
})

describe('buildAgentEntries', () => {
	it('folds an agent with several chats into one row, newest chat first, unread summed', () => {
		const entries = buildAgentEntries(
			[
				chat('old', [actor('cto')], { lastMessageAt: '2026-03-10T09:00:00.000Z', unread_count: 1 }),
				chat('new', [actor('cto')], { lastMessageAt: '2026-03-12T09:00:00.000Z', unread_count: 2 }),
				chat('dm', [actor('cto')], {
					directPairKey: 'pair',
					lastMessageAt: '2026-03-11T09:00:00.000Z',
				}),
			],
			SELF,
		)
		expect(entries).toHaveLength(1)
		const [entry] = entries
		if (entry.kind !== 'agent') throw new Error('expected an agent row')
		expect(entry.conversations.map((c) => c.id)).toEqual(['new', 'dm', 'old'])
		expect(entry.unread).toBe(3)
	})

	it('leaves an agent with one chat, a group chat and a chat with a person as plain rows', () => {
		const entries = buildAgentEntries(
			[
				chat('solo', [actor('re')]),
				chat('group', [actor('cto'), actor('cpo')]),
				chat('person', [actor('sam', 'human')]),
			],
			SELF,
		)
		expect(entries.map((e) => e.kind)).toEqual(['chat', 'chat', 'chat'])
	})

	it('orders rows by latest activity, agent rows and plain rows together', () => {
		const entries = buildAgentEntries(
			[
				chat('a1', [actor('cto')], { lastMessageAt: '2026-03-12T09:00:00.000Z' }),
				chat('a2', [actor('cto')], { lastMessageAt: '2026-03-01T09:00:00.000Z' }),
				chat('group', [actor('cpo'), actor('re')], { lastMessageAt: '2026-03-12T10:00:00.000Z' }),
				chat('person', [actor('sam', 'human')], { lastMessageAt: '2026-03-05T09:00:00.000Z' }),
			],
			SELF,
		)
		expect(entries.map((e) => e.key)).toEqual(['group', 'agent:cto', 'person'])
	})
})

describe('groupByAgent', () => {
	it('puts pinned chats on top as plain rows and keeps them out of their agent fold', () => {
		const groups = groupByAgent(
			[
				chat('pin', [actor('cto')], { pinned: true }),
				chat('b', [actor('cto')]),
				chat('c', [actor('cto')]),
			],
			SELF,
		)
		expect(groups.map((g) => g.label)).toEqual(['Pinned', 'Agents'])
		expect(groups[0].items.map((c) => c.id)).toEqual(['pin'])
		expect(groups[1].entries).toHaveLength(1)
		expect(groups[1].items.map((c) => c.id).sort()).toEqual(['b', 'c'])
	})

	it('drops the Pinned group when nothing is pinned and returns nothing for an empty list', () => {
		expect(groupByAgent([chat('a', [actor('cto')])], SELF).map((g) => g.label)).toEqual(['Agents'])
		expect(groupByAgent([], SELF)).toEqual([])
	})

	it('lists a free-form room first and keeps it out of the agent rows', () => {
		const groups = groupByAgent(
			[chat('room', [actor('cto')], { roomKind: 'free' }), chat('b', [actor('cto')])],
			SELF,
		)
		expect(groups.map((g) => g.label)).toEqual(['Rooms', 'Agents'])
		expect(groups[0].items.map((c) => c.id)).toEqual(['room'])
		expect(groups[1].items.map((c) => c.id)).toEqual(['b'])
	})

	it('leaves a flow room with no messages out of every group', () => {
		const groups = groupByAgent(
			[chat('flow', [actor('cto')], { roomKind: 'flow', snippet: null })],
			SELF,
		)
		expect(groups).toEqual([])
	})
})
