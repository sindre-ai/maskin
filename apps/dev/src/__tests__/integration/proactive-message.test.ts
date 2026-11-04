import {
	events,
	actors,
	conversationParticipants,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { directPairKey } from '../../services/direct-chat'
import { isOptedOut, sendProactiveMessage } from '../../services/proactive-message'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The send must never wake anyone: no model call and no session start.
const spies = vi.hoisted(() => ({ createLLMAdapter: vi.fn(), startSession: vi.fn() }))
vi.mock('../../lib/llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/llm')>()),
	createLLMAdapter: spies.createLLMAdapter,
}))
vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: spies.startSession,
}))

const HOUR_MS = 60 * 60 * 1000

describe('sendProactiveMessage (integration)', () => {
	let workspaceId: string
	let cosId: string
	let otherAgentId: string
	let humanId: string
	let chatId: string
	let keyCount = 0

	function args(overrides: Record<string, unknown> = {}) {
		keyCount++
		return {
			workspaceId,
			senderAgentId: cosId,
			recipientHumanId: humanId,
			reason: 'capability_note',
			content: 'Hey, quick check on what your agents can do.',
			dedupeKey: `key-${keyCount}`,
			...overrides,
		} as Parameters<typeof sendProactiveMessage>[1]
	}

	async function join(actorId: string, role = 'member') {
		await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
	}

	async function makeChat(participantIds: string[], ws = workspaceId) {
		// Two people make a direct message, which is what the sender looks up.
		const [a, b] = participantIds as [string, string]
		const chat = await insertConversation(db, ws, a, {
			directPairKey: participantIds.length === 2 ? directPairKey(a, b) : null,
		})
		for (const actorId of participantIds) {
			await db.insert(conversationParticipants).values({ conversationId: chat.id, actorId })
		}
		return chat.id
	}

	/** A proactive message already in the table, as another agent or an earlier day left it. */
	async function seedProactive(p: {
		conversationId: string
		agentId: string
		reason?: string
		hoursAgo: number
		dedupeKey?: string
	}) {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId: p.conversationId,
				actorId: p.agentId,
				content: 'Earlier note',
				metadata: {
					delivery: {
						kind: 'proactive',
						reason: p.reason ?? 'capability_note',
						dedupe_key: p.dedupeKey ?? `seed-${keyCount++}`,
						version: 1,
					},
				},
				createdAt: new Date(Date.now() - p.hoursAgo * HOUR_MS),
			})
			.returning()
		return row as { id: number }
	}

	async function markRead(conversationId: string, messageId: number) {
		await db
			.update(conversationParticipants)
			.set({ lastReadMessageId: messageId })
			.where(
				and(
					eq(conversationParticipants.conversationId, conversationId),
					eq(conversationParticipants.actorId, humanId),
				),
			)
	}

	async function messagesIn(conversationId: string) {
		return db.select().from(messages).where(eq(messages.conversationId, conversationId))
	}

	beforeEach(async () => {
		spies.createLLMAdapter.mockClear()
		spies.startSession.mockClear()
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		cosId = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' })).id
		otherAgentId = (await insertActor(db, { type: 'agent', name: 'Sales Rep' })).id
		humanId = (await insertActor(db, { type: 'human', name: 'Sam Person' })).id
		await join(cosId)
		await join(otherAgentId)
		await join(humanId)
		chatId = await makeChat([humanId, cosId])
	})

	it('sends one message as Chief of Staff, marked proactive, unread, with no mentions', async () => {
		const result = await sendProactiveMessage(db, args({ dedupeKey: 'first' }))
		expect(result).toEqual({ sent: true, conversationId: chatId, messageId: expect.any(Number) })

		const rows = await messagesIn(chatId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ actorId: cosId, sessionId: null, kind: 'message' })
		expect(rows[0]?.metadata).toEqual({
			delivery: { kind: 'proactive', reason: 'capability_note', dedupe_key: 'first', version: 1 },
		})
		expect(rows[0]?.metadata).not.toHaveProperty('mentions')

		const [state] = await db
			.select()
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, chatId),
					eq(conversationParticipants.actorId, humanId),
				),
			)
		expect(state?.lastReadMessageId).toBeNull()

		const sent = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'proactive_message_sent')))
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ actorId: cosId, entityType: 'conversation', entityId: chatId })
	})

	it('starts no session and makes no model call', async () => {
		await sendProactiveMessage(db, args())
		const sessionRows = await db.select().from(sessions).where(eq(sessions.actorId, cosId))
		expect(sessionRows).toHaveLength(0)
		expect(spies.startSession).not.toHaveBeenCalled()
		expect(spies.createLLMAdapter).not.toHaveBeenCalled()
	})

	it('refuses a sender that is not the Chief of Staff', async () => {
		const agentChat = await makeChat([humanId, otherAgentId])
		const result = await sendProactiveMessage(db, args({ senderAgentId: otherAgentId }))
		expect(result).toEqual({ sent: false, reason: 'sender_not_allowed' })
		expect(await messagesIn(agentChat)).toHaveLength(0)
	})

	it('refuses a paused sender', async () => {
		await db.update(actors).set({ agentState: 'paused' }).where(eq(actors.id, cosId))
		expect(await sendProactiveMessage(db, args())).toEqual({ sent: false, reason: 'sender_paused' })
		expect(await messagesIn(chatId)).toHaveLength(0)
	})

	it('refuses a recipient who is not a member of the workspace', async () => {
		const stranger = await insertActor(db, { type: 'human', name: 'Stranger' })
		await makeChat([stranger.id, cosId])
		const result = await sendProactiveMessage(db, args({ recipientHumanId: stranger.id }))
		expect(result).toEqual({ sent: false, reason: 'recipient_not_member' })
	})

	it('refuses an agent as recipient', async () => {
		const result = await sendProactiveMessage(db, args({ recipientHumanId: otherAgentId }))
		expect(result).toEqual({ sent: false, reason: 'recipient_not_member' })
	})

	it('never creates a chat: a person with no 1-1 gets no_direct_chat', async () => {
		const lonely = await insertActor(db, { type: 'human', name: 'Lonely Person' })
		await join(lonely.id)
		const result = await sendProactiveMessage(db, args({ recipientHumanId: lonely.id }))
		expect(result).toEqual({ sent: false, reason: 'no_direct_chat' })
		const created = await db
			.select()
			.from(conversationParticipants)
			.where(eq(conversationParticipants.actorId, lonely.id))
		expect(created).toHaveLength(0)
	})

	it('a chat with three participants is not a 1-1', async () => {
		await db
			.insert(conversationParticipants)
			.values({ conversationId: chatId, actorId: otherAgentId })
		expect(await sendProactiveMessage(db, args())).toEqual({
			sent: false,
			reason: 'no_direct_chat',
		})
		expect(await messagesIn(chatId)).toHaveLength(0)
	})

	it('the same dedupe key twice sends once', async () => {
		const first = await sendProactiveMessage(db, args({ dedupeKey: 'same' }))
		const second = await sendProactiveMessage(db, args({ dedupeKey: 'same' }))
		expect(first.sent).toBe(true)
		expect(second).toEqual({ sent: false, reason: 'duplicate' })
		expect(await messagesIn(chatId)).toHaveLength(1)
	})

	it('a second send within 24 hours is cap_agent_day', async () => {
		const first = await sendProactiveMessage(db, args({ reason: 'one' }))
		expect(first.sent).toBe(true)
		const second = await sendProactiveMessage(db, args({ reason: 'two' }))
		expect(second).toEqual({ sent: false, reason: 'cap_agent_day' })
		expect(await messagesIn(chatId)).toHaveLength(1)
	})

	it('two proactive messages from other agents in 24 hours is cap_person_day', async () => {
		const second = await insertActor(db, { type: 'agent', name: 'Researcher' })
		await join(second.id)
		const chatA = await makeChat([humanId, otherAgentId])
		const chatB = await makeChat([humanId, second.id])
		await seedProactive({ conversationId: chatA, agentId: otherAgentId, reason: 'a', hoursAgo: 2 })
		await seedProactive({ conversationId: chatB, agentId: second.id, reason: 'b', hoursAgo: 3 })
		expect(await sendProactiveMessage(db, args())).toEqual({
			sent: false,
			reason: 'cap_person_day',
		})
		expect(await messagesIn(chatId)).toHaveLength(0)
	})

	it('one proactive message from another agent still leaves room for Chief of Staff', async () => {
		const chatA = await makeChat([humanId, otherAgentId])
		await seedProactive({ conversationId: chatA, agentId: otherAgentId, reason: 'a', hoursAgo: 2 })
		expect((await sendProactiveMessage(db, args())).sent).toBe(true)
	})

	it('a second capability note inside 7 days is cap_reason_week', async () => {
		const earlier = await seedProactive({ conversationId: chatId, agentId: cosId, hoursAgo: 48 })
		await markRead(chatId, earlier.id)
		expect(await sendProactiveMessage(db, args())).toEqual({
			sent: false,
			reason: 'cap_reason_week',
		})
	})

	it('a note older than 7 days does not count', async () => {
		const earlier = await seedProactive({
			conversationId: chatId,
			agentId: cosId,
			hoursAgo: 24 * 8,
		})
		await markRead(chatId, earlier.id)
		expect((await sendProactiveMessage(db, args())).sent).toBe(true)
	})

	it('an unread previous note blocks the next, a read one does not', async () => {
		const earlier = await seedProactive({
			conversationId: chatId,
			agentId: cosId,
			reason: 'something_else',
			hoursAgo: 72,
		})
		expect(await sendProactiveMessage(db, args())).toEqual({
			sent: false,
			reason: 'unread_backlog',
		})
		await markRead(chatId, earlier.id)
		expect((await sendProactiveMessage(db, args())).sent).toBe(true)
	})

	it('content must be 1 to 1,500 characters', async () => {
		expect(await sendProactiveMessage(db, args({ content: '' }))).toEqual({
			sent: false,
			reason: 'invalid_content',
		})
		expect(await sendProactiveMessage(db, args({ content: 'x'.repeat(1501) }))).toEqual({
			sent: false,
			reason: 'invalid_content',
		})
		expect((await sendProactiveMessage(db, args({ content: 'x'.repeat(1500) }))).sent).toBe(true)
	})

	it('five concurrent calls give exactly one message', async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				sendProactiveMessage(db, args({ dedupeKey: `race-${i}` })),
			),
		)
		expect(results.filter((r) => r.sent)).toHaveLength(1)
		expect(
			results.filter((r) => !r.sent).every((r) => !r.sent && r.reason === 'cap_agent_day'),
		).toBe(true)
		expect(await messagesIn(chatId)).toHaveLength(1)
	})

	it('five concurrent calls with one dedupe key give exactly one message', async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => sendProactiveMessage(db, args({ dedupeKey: 'one-key' }))),
		)
		expect(results.filter((r) => r.sent)).toHaveLength(1)
		expect(await messagesIn(chatId)).toHaveLength(1)
	})

	describe('opt-out by replying stop', () => {
		/** A message the person (or anyone else) typed into the chat, after what is already there. */
		async function say(content: string, actorId = humanId, conversationId = chatId) {
			await db.insert(messages).values({ conversationId, actorId, content })
		}

		/** A note sent a week ago and read, so only the opt-out can block the next send. */
		async function oldReadNote(conversationId = chatId) {
			const note = await seedProactive({ conversationId, agentId: cosId, hoursAgo: 24 * 8 })
			await markRead(conversationId, note.id)
		}

		it('a stop after a note refuses the next send with opted_out and sends nothing', async () => {
			await oldReadNote()
			await say('stop')
			expect(await sendProactiveMessage(db, args())).toEqual({ sent: false, reason: 'opted_out' })
			expect(await messagesIn(chatId)).toHaveLength(2)
			const sent = await db
				.select()
				.from(events)
				.where(
					and(eq(events.workspaceId, workspaceId), eq(events.action, 'proactive_message_sent')),
				)
			expect(sent).toHaveLength(0)
		})

		it('covers every reason, not only the capability note', async () => {
			await oldReadNote()
			await say('stop')
			expect(await sendProactiveMessage(db, args({ reason: 'anything_else' }))).toEqual({
				sent: false,
				reason: 'opted_out',
			})
		})

		it('opts out only that person; another person still gets their note', async () => {
			const other = await insertActor(db, { type: 'human', name: 'Other Person' })
			await join(other.id)
			const otherChat = await makeChat([other.id, cosId])
			await oldReadNote()
			await say('stop')

			expect((await sendProactiveMessage(db, args({ recipientHumanId: other.id }))).sent).toBe(true)
			expect(await messagesIn(otherChat)).toHaveLength(1)
			expect(await sendProactiveMessage(db, args())).toEqual({ sent: false, reason: 'opted_out' })
		})

		it.each(['STOP', ' stop ', 'Stop.', 'stop!', '\n stop \n'])(
			'%j counts as stop',
			async (reply) => {
				await oldReadNote()
				await say(reply)
				expect(await sendProactiveMessage(db, args())).toEqual({
					sent: false,
					reason: 'opted_out',
				})
			},
		)

		it.each([
			'tell me more',
			'I will stop by later',
			'stop it',
			"don't stop",
			'please stop',
			'stopping',
			'stop sending',
		])('%j does not opt out', async (reply) => {
			await oldReadNote()
			await say(reply)
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})

		it('a stop typed before any proactive note does not opt anyone out', async () => {
			await say('stop')
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})

		it('start on its own changes nothing', async () => {
			await oldReadNote()
			await say('start')
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})

		it('the newest of stop and start wins', async () => {
			await oldReadNote()
			await say('stop')
			expect(await sendProactiveMessage(db, args())).toEqual({ sent: false, reason: 'opted_out' })
			await say('start')
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})

		it('stop, start, stop is opted out', async () => {
			await oldReadNote()
			await say('stop')
			await say('start')
			await say('stop')
			expect(await isOptedOut(db, { conversationId: chatId, recipientHumanId: humanId })).toBe(true)
		})

		it('a stop from someone else in the chat does not count', async () => {
			await oldReadNote()
			await say('stop', cosId)
			await say('stop', otherAgentId)
			expect(await isOptedOut(db, { conversationId: chatId, recipientHumanId: humanId })).toBe(
				false,
			)
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})

		it('a refused send uses no cap: the first send after start still goes out', async () => {
			await oldReadNote()
			await say('stop')
			await sendProactiveMessage(db, args())
			await sendProactiveMessage(db, args())
			await say('start')
			expect((await sendProactiveMessage(db, args())).sent).toBe(true)
		})
	})
})
