import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { events, conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { insertConversationMessage } from '../../services/conversation-messages'
import { directPairKey, findDirectChat, findOrCreateDirectChat } from '../../services/direct-chat'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The direct message (DM) primitive against real Postgres. The marker, the unique
// index and the lock (one chat from two concurrent callers) are database
// semantics, so a mocked db could not show any of them.

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

	/** A chat with exactly these two people. Marked as their DM unless it is topical. */
	async function chatBetween(
		a: string,
		b: string,
		opts: { topical?: boolean; lastMessageAt?: Date } = {},
	) {
		const chat = await insertConversation(db, workspaceId, a, {
			directPairKey: opts.topical ? null : directPairKey(a, b),
			...(opts.lastMessageAt ? { lastMessageAt: opts.lastMessageAt } : {}),
		})
		await addParticipant(chat.id, a)
		await addParticipant(chat.id, b)
		return chat
	}

	describe('directPairKey', () => {
		it('is the same whichever actor comes first', () => {
			expect(directPairKey(humanId, agentId)).toBe(directPairKey(agentId, humanId))
		})
	})

	describe('findDirectChat', () => {
		it('returns the DM between the two', async () => {
			const chat = await chatBetween(humanId, agentId)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({ id: chat.id })
		})

		it('never returns a topical chat, even a newer one with the same two people', async () => {
			const dm = await chatBetween(humanId, agentId, { lastMessageAt: new Date('2026-01-01') })
			await chatBetween(humanId, agentId, { topical: true, lastMessageAt: new Date('2026-06-01') })

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({ id: dm.id })
		})

		it('returns null when the only chat with the agent is topical', async () => {
			await chatBetween(humanId, agentId, { topical: true })

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})

		it('returns null once one of the two has left the DM', async () => {
			const chat = await insertConversation(db, workspaceId, humanId, {
				directPairKey: directPairKey(humanId, agentId),
			})
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId, { leftAt: new Date() })

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})

		it('returns null while a third person is in the DM', async () => {
			const other = await insertActor(db, { type: 'agent' })
			const chat = await chatBetween(humanId, agentId)
			await addParticipant(chat.id, other.id)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})

		it('returns null for a DM in another workspace', async () => {
			const otherWorkspace = await insertWorkspace(db, getTestActorId())
			const chat = await insertConversation(db, otherWorkspace.id, humanId, {
				directPairKey: directPairKey(humanId, agentId),
			})
			await addParticipant(chat.id, humanId)
			await addParticipant(chat.id, agentId)

			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toBeNull()
		})
	})

	describe('findOrCreateDirectChat', () => {
		const args = () => ({ workspaceId, humanId, agentId, title: 'Ada', createdBy: humanId })

		it('creates the marked conversation, both participants and the event when no DM exists', async () => {
			const result = await findOrCreateDirectChat(db, args())
			expect(result.created).toBe(true)

			const [conversation] = await db
				.select()
				.from(conversations)
				.where(eq(conversations.id, result.id))
			expect(conversation).toMatchObject({
				workspaceId,
				title: 'Ada',
				titleAutoState: 'none',
				createdBy: humanId,
				directPairKey: directPairKey(humanId, agentId),
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

		it('returns the same DM on every call, and for either order of the pair', async () => {
			const first = await findOrCreateDirectChat(db, args())
			const second = await findOrCreateDirectChat(db, args())
			const swapped = await findOrCreateDirectChat(db, {
				...args(),
				humanId: agentId,
				agentId: humanId,
			})

			expect(first.created).toBe(true)
			expect([second, swapped]).toEqual([
				{ id: first.id, created: false },
				{ id: first.id, created: false },
			])
			const all = await db
				.select()
				.from(conversations)
				.where(eq(conversations.workspaceId, workspaceId))
			expect(all).toHaveLength(1)
		})

		it('creates the DM next to a topical chat with the same two people and leaves the topical chat alone', async () => {
			const topical = await chatBetween(humanId, agentId, { topical: true })

			const result = await findOrCreateDirectChat(db, args())

			expect(result.created).toBe(true)
			expect(result.id).not.toBe(topical.id)
			const [still] = await db.select().from(conversations).where(eq(conversations.id, topical.id))
			expect(still?.directPairKey).toBeNull()
		})

		it('brings back a participant who left the DM instead of creating another', async () => {
			const dm = await findOrCreateDirectChat(db, args())
			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, dm.id),
						eq(conversationParticipants.actorId, humanId),
					),
				)

			const again = await findOrCreateDirectChat(db, args())

			expect(again).toEqual({ id: dm.id, created: false })
			expect(await findDirectChat(db, { workspaceId, humanId, agentId })).toEqual({ id: dm.id })
		})

		it('keeps one DM per pair at the database, not only under the lock', async () => {
			await findOrCreateDirectChat(db, args())

			await expect(
				insertConversation(db, workspaceId, humanId, {
					directPairKey: directPairKey(humanId, agentId),
				}),
			).rejects.toThrow()
			// Any number of topical chats is fine.
			await insertConversation(db, workspaceId, humanId)
			await insertConversation(db, workspaceId, humanId)
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

	describe('the 0117 backfill', () => {
		// The migration's last statement, run on rows the old way made: chats with
		// no marker. Rolled back at the end so it cannot touch other tests' rows.
		const backfill = readFileSync(
			join(__dirname, '../../../../../packages/db/drizzle/0117_conversations_direct_pair_key.sql'),
			'utf-8',
		)
			.split('--> statement-breakpoint')
			.pop() as string

		async function runBackfill() {
			const marked = new Map<string, string | null>()
			const rollback = new Error('rollback')
			await db
				.transaction(async (tx) => {
					await tx.execute(sql.raw(backfill))
					const rows = await tx
						.select({ id: conversations.id, key: conversations.directPairKey })
						.from(conversations)
					for (const r of rows) marked.set(r.id, r.key)
					throw rollback
				})
				.catch((err) => {
					if (err !== rollback) throw err
				})
			return marked
		}

		it('marks one chat per person and agent pair, the most recently used, and no other', async () => {
			const otherAgent = await insertActor(db, { type: 'agent' })
			const colleague = await insertActor(db, { type: 'human' })

			const older = await chatBetween(humanId, agentId, {
				topical: true,
				lastMessageAt: new Date('2026-01-01'),
			})
			const newer = await chatBetween(humanId, agentId, {
				topical: true,
				lastMessageAt: new Date('2026-06-01'),
			})
			const otherPair = await chatBetween(humanId, otherAgent.id, { topical: true })
			const personToPerson = await chatBetween(humanId, colleague.id, { topical: true })
			const agentToAgent = await chatBetween(agentId, otherAgent.id, { topical: true })

			const group = await chatBetween(humanId, agentId, { topical: true })
			await addParticipant(group.id, otherAgent.id)

			const aboutSomething = await insertConversation(db, workspaceId, humanId, {
				subjectType: 'object',
				subjectId: crypto.randomUUID(),
			})
			await addParticipant(aboutSomething.id, humanId)
			await addParticipant(aboutSomething.id, agentId)

			const otherWorkspace = await insertWorkspace(db, getTestActorId())
			const elsewhere = await insertConversation(db, otherWorkspace.id, humanId, {
				lastMessageAt: new Date('2025-01-01'),
			})
			await addParticipant(elsewhere.id, humanId)
			await addParticipant(elsewhere.id, agentId)

			const marked = await runBackfill()

			expect(marked.get(newer.id)).toBe(directPairKey(humanId, agentId))
			expect(marked.get(older.id)).toBeNull()
			expect(marked.get(otherPair.id)).toBe(directPairKey(humanId, otherAgent.id))
			expect(marked.get(personToPerson.id)).toBeNull()
			expect(marked.get(agentToAgent.id)).toBeNull()
			expect(marked.get(group.id)).toBeNull()
			expect(marked.get(aboutSomething.id)).toBeNull()
			// The same pair in another workspace has its own DM.
			expect(marked.get(elsewhere.id)).toBe(directPairKey(humanId, agentId))
			// The marked chat is the one the app now finds.
			const dmIds = [...marked].filter(([, key]) => key === directPairKey(humanId, agentId))
			expect(dmIds.map(([id]) => id).sort()).toEqual([newer.id, elsewhere.id].sort())
		})
	})

	describe('insertConversationMessage inside a transaction', () => {
		it('leaves no message row when the transaction is rolled back', async () => {
			const chat = await chatBetween(humanId, agentId)

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
