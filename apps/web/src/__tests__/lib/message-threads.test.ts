import {
	defaultReplyRecipient,
	isTimelineMessage,
	replyPillLabel,
	threadRootOfQueryKey,
} from '@/lib/message-threads'
import { queryKeys } from '@/lib/query-keys'
import { describe, expect, it } from 'vitest'

describe('isTimelineMessage', () => {
	it.each([
		['a top-level message (field absent)', {}, true],
		['a top-level message (null root)', { threadRootId: null }, true],
		['a reply', { threadRootId: 5 }, false],
		[
			'a reply that is not also in the channel',
			{ threadRootId: 5, threadAlsoInChannel: false },
			false,
		],
		['a reply also sent to the channel', { threadRootId: 5, threadAlsoInChannel: true }, true],
	])('%s', (_name, message, expected) => {
		expect(isTimelineMessage(message)).toBe(expected)
	})
})

describe('threadRootOfQueryKey', () => {
	it('returns null for a main-list messages key', () => {
		expect(threadRootOfQueryKey(queryKeys.conversations.messages('c1', { limit: 50 }))).toBeNull()
	})

	it('returns the root id for a thread messages key', () => {
		expect(threadRootOfQueryKey(queryKeys.conversations.threadMessages('c1', 42))).toBe(42)
	})

	it('returns null for keys without a filters object', () => {
		expect(threadRootOfQueryKey(queryKeys.conversations.messagesPrefix('c1'))).toBeNull()
		expect(threadRootOfQueryKey(queryKeys.conversations.detail('c1'))).toBeNull()
		expect(
			threadRootOfQueryKey(['conversations', 'detail', 'c1', 'messages', undefined]),
		).toBeNull()
	})
})

describe('defaultReplyRecipient', () => {
	const agentA = { actorId: 'agent-a', actorName: 'Forge', actorType: 'agent' }
	const agentB = { actorId: 'agent-b', actorName: 'Scout', actorType: 'agent' }
	const human = { actorId: 'human-1', actorName: 'Ada', actorType: 'human' }

	it('addresses the root author when it is an agent', () => {
		const root = { actorId: 'agent-a', actorName: 'Forge', actorType: 'agent' as const }
		expect(defaultReplyRecipient(root, [agentB], 'me')).toEqual({ id: 'agent-a', name: 'Forge' })
	})

	it('falls to the first agent participant when the root author is human', () => {
		const root = { actorId: 'human-1', actorName: 'Ada', actorType: 'human' as const }
		expect(defaultReplyRecipient(root, [human, agentB, agentA], 'me')).toEqual({
			id: 'agent-b',
			name: 'Scout',
		})
	})

	it('never addresses the sender', () => {
		const root = { actorId: 'agent-a', actorName: 'Forge', actorType: 'agent' as const }
		expect(defaultReplyRecipient(root, [agentA, agentB], 'agent-a')).toEqual({
			id: 'agent-b',
			name: 'Scout',
		})
	})

	it('returns null when no agent is involved', () => {
		const root = { actorId: 'human-1', actorName: 'Ada', actorType: 'human' as const }
		expect(defaultReplyRecipient(root, [human], 'me')).toBeNull()
	})
})

describe('replyPillLabel', () => {
	it.each([
		[{ replyCount: 1, unreadCount: 0 }, '1 reply'],
		[{ replyCount: 3, unreadCount: 0 }, '3 replies'],
		[{ replyCount: 3, unreadCount: 1 }, '1 new reply'],
		[{ replyCount: 5, unreadCount: 2 }, '2 new replies'],
	])('%j reads %s', (summary, label) => {
		expect(replyPillLabel(summary)).toBe(label)
	})
})
