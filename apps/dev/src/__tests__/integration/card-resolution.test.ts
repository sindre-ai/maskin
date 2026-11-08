import { messages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertConversationMessage } from '../../services/conversation-messages'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A request card records when and by whom it was answered, on its own message. Against real
 * Postgres: the stamp is a jsonb update guarded by the conversation, the card kind and the
 * first answer.
 */

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	const conversation = await insertConversation(db, ws.id, human)
	const post = (
		over: Partial<Parameters<typeof insertConversationMessage>[1]> & { conversationId?: string },
	) =>
		insertConversationMessage(db, {
			conversationId: conversation.id,
			workspaceId: ws.id,
			actorId: human,
			content: 'x',
			metadata: null,
			sessionId: null,
			...over,
		})
	const card = async (
		metadata: Record<string, unknown> = { computer_request: { task: 'Log in' } },
	) => {
		const created = await post({
			actorId: agent.id,
			content: 'Please help.',
			metadata: metadata as never,
		})
		if (!created) throw new Error('card not created')
		return created
	}
	const resolved = async (id: number) => {
		const [row] = await db.select().from(messages).where(eq(messages.id, id))
		return (row.metadata as { card_resolved?: Record<string, string> }).card_resolved
	}
	return { human, ws, agent, conversation, post, card, resolved }
}

describe('card_answer on a message (Integration)', () => {
	it('writes the answer time and the answerer onto the card, for Not now and for Done', async () => {
		const s = await setup()
		const declinedCard = await s.card({
			keychain_request: { session_id: crypto.randomUUID(), kind: 'api_key' },
		})
		const doneCard = await s.card()

		const no = await s.post({
			content: 'Not now',
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: declinedCard.id, outcome: 'declined' },
			},
		})
		const yes = await s.post({
			content: 'Done',
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: doneCard.id, outcome: 'done' },
			},
		})

		expect(await s.resolved(declinedCard.id)).toEqual({
			at: no?.createdAt.toISOString(),
			by_actor_id: s.human,
			outcome: 'declined',
		})
		expect(await s.resolved(doneCard.id)).toEqual({
			at: yes?.createdAt.toISOString(),
			by_actor_id: s.human,
			outcome: 'done',
		})
	})

	it('keeps the first answer when a second one arrives', async () => {
		const s = await setup()
		const card = await s.card()
		await s.post({ metadata: { card_answer: { message_id: card.id, outcome: 'declined' } } })
		const first = await s.resolved(card.id)

		await s.post({ metadata: { card_answer: { message_id: card.id, outcome: 'done' } } })

		expect(await s.resolved(card.id)).toEqual(first)
	})

	it('ignores an answer aimed at a plain message or at a card in another chat', async () => {
		const s = await setup()
		const plain = await s.post({ content: 'Hello' })
		const elsewhere = await insertConversation(db, s.ws.id, s.human)
		const foreign = await insertConversationMessage(db, {
			conversationId: elsewhere.id,
			workspaceId: s.ws.id,
			actorId: s.agent.id,
			content: 'Please help.',
			metadata: { computer_request: { session_id: crypto.randomUUID(), task: 'Log in' } },
			sessionId: null,
		})

		await s.post({ metadata: { card_answer: { message_id: plain?.id ?? 0, outcome: 'done' } } })
		await s.post({ metadata: { card_answer: { message_id: foreign?.id ?? 0, outcome: 'done' } } })

		expect(await s.resolved(plain?.id ?? 0)).toBeUndefined()
		expect(await s.resolved(foreign?.id ?? 0)).toBeUndefined()
	})
})
