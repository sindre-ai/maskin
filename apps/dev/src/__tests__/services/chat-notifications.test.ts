import type { Database } from '@maskin/db'
import {
	CHAT_REPLY_PUSH_DELAY_SECONDS,
	notifyAgentQuestion,
	notifyChatMention,
	notifyChatReply,
	previewText,
} from '../../services/chat-notifications'
import { createTestContext } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'
const conv = '00000000-0000-0000-0000-0000000000c1'
const agent = '00000000-0000-0000-0000-0000000000d1'
const human1 = '00000000-0000-0000-0000-0000000000a1'
const human2 = '00000000-0000-0000-0000-0000000000a2'

type Rows = Array<Record<string, unknown>>
const notificationRows = (inserts: unknown[]) =>
	(inserts.find((v) => Array.isArray(v) && v[0] && 'sourceActorId' in v[0]) ?? []) as Rows

function reply(over: Record<string, unknown> = {}) {
	return {
		workspaceId: wsId,
		authorId: agent,
		conversationId: conv,
		messageId: 42,
		content: '**Done.** See [the report](https://x.test/r) for `details`.',
		kind: 'message' as const,
		metadata: { source: 'final_output' as const, final_output: { dedupe_key: 'k' } },
		sessionId: null,
		...over,
	}
}

function ctx(selects: unknown[][]) {
	const c = createTestContext()
	c.mockResults.selectQueue = selects
	c.mockResults.insert = [{ id: 'n1' }]
	return c
}

describe('previewText', () => {
	it('strips markdown and collapses whitespace', () => {
		expect(previewText('# Title\n\n**Done.** See [the report](https://x.test) for `code`.')).toBe(
			'Title Done. See the report for code.',
		)
	})

	it('drops fenced code and truncates to 140 chars with an ellipsis', () => {
		expect(previewText('```ts\nconst a = 1\n```\nhello')).toBe('hello')
		const out = previewText('word '.repeat(80))
		expect(out.length).toBeLessThanOrEqual(140)
		expect(out.endsWith('…')).toBe(true)
	})
})

describe('notifyChatReply', () => {
	it('creates one conversation row per human participant with the push contract', async () => {
		const { db, calls } = ctx([
			[{ name: 'Ada', type: 'agent' }],
			[{ actorId: human1 }, { actorId: human2 }],
			[],
		])

		await notifyChatReply(db as Database, reply())

		const rows = notificationRows(calls.inserts)
		expect(rows.map((r) => r.targetActorId)).toEqual([human1, human2])
		expect(rows[0]).toMatchObject({
			title: 'Ada',
			content: 'Done. See the report for details.',
			sourceActorId: agent,
			type: 'good_news',
			status: 'seen',
			metadata: {
				push_category: 'conversation',
				push_collapse_key: `chat:${conv}`,
				push_delay_seconds: CHAT_REPLY_PUSH_DELAY_SECONDS,
				push_only: true,
				conversation_id: conv,
				message_id: 42,
			},
		})
	})

	it('skips a target that already has a row for this message', async () => {
		const { db, calls } = ctx([
			[{ name: 'Ada', type: 'agent' }],
			[{ actorId: human1 }, { actorId: human2 }],
			[{ targetActorId: human1 }],
		])

		await notifyChatReply(db as Database, reply())

		expect(notificationRows(calls.inserts).map((r) => r.targetActorId)).toEqual([human2])
	})

	it('uses needs_input when the message carries a question', async () => {
		const { db, calls } = ctx([[{ name: 'Ada', type: 'agent' }], [{ actorId: human1 }], []])

		await notifyChatReply(
			db as Database,
			reply({
				metadata: {
					source: 'final_output',
					question: { session_id: agent, questions: [] },
				},
			}),
		)

		const [row] = notificationRows(calls.inserts)
		expect(row).toMatchObject({ type: 'needs_input', status: 'pending' })
		expect(row?.metadata).toMatchObject({ push_category: 'needs_you' })
		expect(row?.metadata).not.toHaveProperty('push_delay_seconds')
	})

	it.each([
		['a mid-turn message without final_output source', { metadata: null }],
		['a system message', { kind: 'system' }],
		[
			'a failed turn',
			{ metadata: { source: 'final_output', final_output: { dedupe_key: 'k', is_error: true } } },
		],
		[
			'a retry notice',
			{
				metadata: {
					source: 'final_output',
					final_output: { dedupe_key: 'k', retry: 'unanswered' },
				},
			},
		],
	])('creates nothing for %s', async (_name, over) => {
		const { db, calls } = ctx([[{ name: 'Ada', type: 'agent' }], [{ actorId: human1 }], []])

		await notifyChatReply(db as Database, reply(over))

		expect(calls.inserts).toHaveLength(0)
	})

	it('creates nothing for a person writing in a group chat', async () => {
		const { db, calls } = ctx([
			[{ name: 'Bob', type: 'human' }],
			[
				{ actorId: human1, type: 'human', archived: false },
				{ actorId: human2, type: 'human', archived: false },
				{ actorId: agent, type: 'agent', archived: false },
			],
		])

		await notifyChatReply(db as Database, reply({ authorId: human1, metadata: null }))

		expect(calls.inserts).toHaveLength(0)
	})

	it('pushes the other person when a person writes in a direct chat between two people', async () => {
		const { db, calls } = ctx([
			[{ name: 'Bob', type: 'human' }],
			[
				{ actorId: human1, type: 'human', archived: false },
				{ actorId: human2, type: 'human', archived: false },
			],
			[],
		])

		await notifyChatReply(
			db as Database,
			reply({ authorId: human1, content: 'Hey, got a minute?', metadata: null }),
		)

		const rows = notificationRows(calls.inserts)
		expect(rows.map((r) => r.targetActorId)).toEqual([human2])
		expect(rows[0]).toMatchObject({
			title: 'Bob',
			content: 'Hey, got a minute?',
			sourceActorId: human1,
			type: 'good_news',
			status: 'seen',
			metadata: {
				push_category: 'conversation',
				push_collapse_key: `chat:${conv}`,
				push_delay_seconds: CHAT_REPLY_PUSH_DELAY_SECONDS,
				push_only: true,
				conversation_id: conv,
				message_id: 42,
			},
		})
	})

	it('creates nothing in a chat with an agent, or when the other person archived the chat', async () => {
		const withAgent = ctx([
			[{ name: 'Bob', type: 'human' }],
			[
				{ actorId: human1, type: 'human', archived: false },
				{ actorId: agent, type: 'agent', archived: false },
			],
		])
		await notifyChatReply(withAgent.db as Database, reply({ authorId: human1, metadata: null }))
		expect(withAgent.calls.inserts).toHaveLength(0)

		const archived = ctx([
			[{ name: 'Bob', type: 'human' }],
			[
				{ actorId: human1, type: 'human', archived: false },
				{ actorId: human2, type: 'human', archived: true },
			],
		])
		await notifyChatReply(archived.db as Database, reply({ authorId: human1, metadata: null }))
		expect(archived.calls.inserts).toHaveLength(0)
	})

	it('creates nothing when no human is left to notify', async () => {
		const { db, calls } = ctx([[{ name: 'Ada', type: 'agent' }], []])

		await notifyChatReply(db as Database, reply())

		expect(calls.inserts).toHaveLength(0)
	})

	it('swallows a database failure', async () => {
		const { db, mockResults } = ctx([[{ name: 'Ada', type: 'agent' }], [{ actorId: human1 }], []])
		mockResults.insertError = new Error('boom')

		await expect(notifyChatReply(db as Database, reply())).resolves.toBeUndefined()
	})
})

describe('notifyAgentQuestion', () => {
	const args = {
		workspaceId: wsId,
		agentId: agent,
		conversationId: conv,
		messageId: 9,
		targets: [human1],
		firstQuestion: 'How should I reach Spotify?',
		objectId: '00000000-0000-0000-0000-0000000000b1',
		sessionId: '00000000-0000-0000-0000-0000000000e1',
	}

	it('creates a pending needs_input row for the asked human', async () => {
		const { db, calls } = ctx([[{ name: 'Ada', type: 'agent' }], []])

		await notifyAgentQuestion(db as Database, args)

		const [row] = notificationRows(calls.inserts)
		expect(row).toMatchObject({
			type: 'needs_input',
			status: 'pending',
			title: 'Ada has a question',
			content: 'How should I reach Spotify?',
			targetActorId: human1,
			sourceActorId: agent,
			objectId: args.objectId,
			sessionId: args.sessionId,
			metadata: {
				push_category: 'needs_you',
				push_collapse_key: `chat:${conv}`,
				conversation_id: conv,
				message_id: 9,
			},
		})
	})

	it('swallows a database failure', async () => {
		const { db, mockResults } = ctx([[{ name: 'Ada', type: 'agent' }], []])
		mockResults.insertError = new Error('boom')

		await expect(notifyAgentQuestion(db as Database, args)).resolves.toBeUndefined()
	})
})

describe('notifyChatMention', () => {
	function mention(over: Record<string, unknown> = {}) {
		return {
			workspaceId: wsId,
			authorId: human2,
			conversationId: conv,
			messageId: 7,
			content: 'Can you look at **this**?',
			kind: 'message' as const,
			metadata: { mentions: [human1] },
			sessionId: null,
			...over,
		}
	}

	it('creates an immediate conversation push for the mentioned person, under its own collapse key', async () => {
		const { db, calls } = ctx([[{ name: 'Sam', type: 'human' }], [{ id: human1 }], []])

		await notifyChatMention(db as Database, mention())

		const [row] = notificationRows(calls.inserts)
		expect(row).toMatchObject({
			title: 'Sam mentioned you',
			content: 'Can you look at this?',
			targetActorId: human1,
			sourceActorId: human2,
			type: 'good_news',
			status: 'seen',
			metadata: {
				push_category: 'conversation',
				push_collapse_key: `chat-mention:${conv}:7`,
				push_only: true,
				conversation_id: conv,
				message_id: 7,
			},
		})
		expect(row?.metadata).not.toHaveProperty('push_delay_seconds')
	})

	it.each([
		['an auto-posted final output', { metadata: { source: 'final_output', mentions: [human1] } }],
		['a system message', { kind: 'system' }],
		['a message with no mentions', { metadata: { mentions: [] } }],
		['a self-mention', { metadata: { mentions: [human2] } }],
	])('creates nothing for %s', async (_name, over) => {
		const { db, calls } = ctx([[{ name: 'Sam', type: 'human' }], [{ id: human1 }], []])

		await notifyChatMention(db as Database, mention(over))

		expect(calls.inserts).toHaveLength(0)
	})

	it('creates nothing when no mentioned id is a workspace-member human', async () => {
		const { db, calls } = ctx([[{ name: 'Sam', type: 'human' }], [], []])

		await notifyChatMention(db as Database, mention({ metadata: { mentions: [agent] } }))

		expect(calls.inserts).toHaveLength(0)
	})
})
