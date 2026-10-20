import { events, conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertConversationMessage } from '../../services/conversation-messages'
import { findDirectChat, findOrCreateDirectChat } from '../../services/direct-chat'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The 1-1 primitive against real Postgres. The lock (one chat from two
// concurrent callers) and the find (exactly two active participants) are
// database semantics, so a mocked db could not show either.

async function addParticipant(
	conversationId: string,
	actorId: string,
	overrides: { leftAt?: Date } = {},
) {
	await db.insert(conversationParticipants).values({ conversationId, actorId, ...overrides })
}

describe('Direct chat primitive', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		const owner = getTestActorId()
		workspaceId = (await insertWorkspace(db, owner)).id
		humanId = (await insertActor(db, { type: 'human' })).id
		agentId = (await insertActor(db, { type: 'agent' })).id
	})

	describe('findDirectChat', () => {
		it('returns an existing exact two-person chat', async () => {
			const chat = await insertConversation(db, workspaceId, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({ id: chat.id })
		})

		it('returns null when a conversation has 3 active participants', async () => {
			const other = await insertActor(db, { type: 'agent' })
			const chat = await insertConversation(db, workspaceId, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)
			await addParticipant(chat.id, other.id)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})

		it('does not count a participant who left', async () => {
			const other = await insertActor(db, { type: 'agent' })
			const chat = await insertConversation(db, workspaceId, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)
			await addParticipant(chat.id, other.id, { leftAt: new Date() })

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({ id: chat.id })
		})

		it('returns null for a chat in another workspace', async () => {
			const otherWorkspace = await insertWorkspace(db, getTestActorId())
			const chat = await insertConversation(db, otherWorkspace.id, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})
	})

	describe('findOrCreateDirectChat', () => {
		const args = () => ({ workspaceId, humanId, agentId, title: 'Meet Ada', createdBy: humanId })

		it('creates the conversation, both participants and the event when no chat exists', async () => {
			const result = await findOrCreateDirectChat(db, args())
			expect(result.created).toBe(true)

			const [conversation] = await db
				.select()
				.from(conversations)
				.where(eq(conversations.id, result.id))
			expect(conversation).toMatchObject({
				workspaceId,
				title: 'Meet Ada',
				titleAutoState: 'none',
				createdBy: humanId,
			})

			const participants = await db
				.select()
				.from(conversationParticipants)
				.where(eq(conversationParticipants.conversationId, result.id))
			expect(participants.map((p) => p.actorId).sort()).toEqual([humanId, agentId].sort())
			for (const p of participants) {
				expect(p).toMatchObject({
					addedBy: humanId,
					pinned: false,
					archived: false,
					lastReadMessageId: null,
					leftAt: null,
				})
			}

			const created = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, result.id), eq(events.action, 'conversation_created')))
			expect(created).toHaveLength(1)
			expect(created[0]).toMatchObject({
				workspaceId,
				actorId: humanId,
				entityType: 'conversation',
				data: { participant_actor_ids: [humanId, agentId] },
			})

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({
				id: result.id,
			})
		})

		it('returns an existing exact two-person chat instead of creating another', async () => {
			const chat = await insertConversation(db, workspaceId, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)

			const result = await findOrCreateDirectChat(db, args())

			expect(result).toEqual({ id: chat.id, created: false })
			const all = await db
				.select()
				.from(conversations)
				.where(eq(conversations.workspaceId, workspaceId))
			expect(all).toHaveLength(1)
		})

		it('makes two concurrent calls for the same pair produce one conversation', async () => {
			const results = await Promise.all([
				findOrCreateDirectChat(db, args()),
				findOrCreateDirectChat(db, args()),
			])

			expect(results[0].id).toBe(results[1].id)
			expect(results.filter((r) => r.created)).toHaveLength(1)
			const all = await db
				.select()
				.from(conversations)
				.where(eq(conversations.workspaceId, workspaceId))
			expect(all).toHaveLength(1)
		})

		it('makes concurrent calls for different pairs produce one chat each', async () => {
			const otherAgent = await insertActor(db, { type: 'agent' })

			const results = await Promise.all([
				findOrCreateDirectChat(db, args()),
				findOrCreateDirectChat(db, { ...args(), agentId: otherAgent.id }),
			])

			expect(results[0].id).not.toBe(results[1].id)
			expect(results.every((r) => r.created)).toBe(true)
		})

		it('joins an outer transaction, so a rollback leaves no chat behind', async () => {
			await expect(
				db.transaction(async (tx) => {
					await findOrCreateDirectChat(tx, args())
					throw new Error('rollback')
				}),
			).rejects.toThrow('rollback')

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})
	})

	describe('insertConversationMessage inside a transaction', () => {
		it('leaves no message row when the transaction is rolled back', async () => {
			const chat = await insertConversation(db, workspaceId, humanId)
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)

			await expect(
				db.transaction(async (tx) => {
					const created = await insertConversationMessage(tx, {
						conversationId: chat.id,
						workspaceId,
						actorId: agentId,
						content: 'rolled back',
						metadata: null,
						sessionId: null,
					})
					expect(created).not.toBeNull()
					throw new Error('rollback')
				}),
			).rejects.toThrow('rollback')

			const rows = await db.select().from(messages).where(eq(messages.conversationId, chat.id))
			expect(rows).toHaveLength(0)
		})
	})
})
