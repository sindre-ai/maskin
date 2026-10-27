import { conversationParticipants, conversations, masterChats } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	findMasterChatPair,
	findOrCreateMasterChat,
	wouldWidenMasterChat,
} from '../../services/master-chat'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The master chat is a stored row, so its guarantees are database facts: one chat per pair even
 * when two callers race, a key that refuses a second row, and a lookup that ignores topical chats.
 * Real Postgres, because none of that can be seen through a mocked database.
 */

async function setup() {
	const humanId = getTestActorId()
	const workspace = await insertWorkspace(db, humanId)
	const agent = await insertActor(db, { type: 'agent' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	return { humanId, workspaceId: workspace.id, agent }
}

const rowsFor = (workspaceId: string) =>
	db.select().from(masterChats).where(eq(masterChats.workspaceId, workspaceId))

describe('findOrCreateMasterChat', () => {
	it('creates the chat with the person and the agent in it, titled with the agent name', async () => {
		const { humanId, workspaceId, agent } = await setup()

		const chat = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)

		expect(chat).toMatchObject({ created: true })
		const [conversation] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, chat?.id as string))
		expect(conversation).toMatchObject({ workspaceId, title: agent.name, titleAutoState: 'none' })
		const participants = await db
			.select({ actorId: conversationParticipants.actorId })
			.from(conversationParticipants)
			.where(eq(conversationParticipants.conversationId, chat?.id as string))
		expect(participants.map((p) => p.actorId).sort()).toEqual([humanId, agent.id].sort())
		expect(await rowsFor(workspaceId)).toHaveLength(1)
	})

	it('returns the same chat on every later call', async () => {
		const { humanId, workspaceId, agent } = await setup()

		const first = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)
		const second = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)

		expect(second).toEqual({ id: first?.id, created: false })
		expect(await rowsFor(workspaceId)).toHaveLength(1)
	})

	it('makes one chat and one row when several first calls arrive at once', async () => {
		const { humanId, workspaceId, agent } = await setup()

		const results = await Promise.all(
			Array.from({ length: 5 }, () => findOrCreateMasterChat(db, workspaceId, humanId, agent.id)),
		)

		expect(new Set(results.map((r) => r?.id)).size).toBe(1)
		expect(results.filter((r) => r?.created)).toHaveLength(1)
		expect(await rowsFor(workspaceId)).toHaveLength(1)
		// The callers that lost the race rolled their chat back: nothing is left behind.
		const chats = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.workspaceId, workspaceId))
		expect(chats).toHaveLength(1)
	})

	it('gives each agent its own chat with the same person', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const other = await insertActor(db, { type: 'agent' })
		await ensureWorkspaceMember(db, workspaceId, other.id)

		const [a, b] = await Promise.all([
			findOrCreateMasterChat(db, workspaceId, humanId, agent.id),
			findOrCreateMasterChat(db, workspaceId, humanId, other.id),
		])

		expect(a?.id).not.toBe(b?.id)
		expect(await rowsFor(workspaceId)).toHaveLength(2)
	})

	it('never returns a topical chat that holds only the same two people', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const topical = await insertConversation(db, workspaceId, humanId, { title: 'Pricing' })
		if (!topical) throw new Error('failed to seed conversation')
		await db.insert(conversationParticipants).values([
			{ conversationId: topical.id, actorId: humanId },
			{ conversationId: topical.id, actorId: agent.id },
		])

		const chat = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)

		expect(chat?.id).not.toBe(topical.id)
		expect(chat?.created).toBe(true)
	})

	it('returns null for someone outside the workspace, or the wrong kind of actor', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const outsider = await insertActor(db, { type: 'human' })
		const strayAgent = await insertActor(db, { type: 'agent' })

		expect(await findOrCreateMasterChat(db, workspaceId, outsider.id, agent.id)).toBeNull()
		expect(await findOrCreateMasterChat(db, workspaceId, humanId, strayAgent.id)).toBeNull()
		expect(await findOrCreateMasterChat(db, workspaceId, agent.id, humanId)).toBeNull()
		expect(await rowsFor(workspaceId)).toEqual([])
	})
})

describe('master_chats keys', () => {
	it('refuses a second row for the same pair, and one chat for two pairs', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const other = await insertActor(db, { type: 'agent' })
		await ensureWorkspaceMember(db, workspaceId, other.id)
		const chat = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)
		const spare = await insertConversation(db, workspaceId, humanId)
		if (!chat || !spare) throw new Error('failed to seed')

		await expect(
			db
				.insert(masterChats)
				.values({ workspaceId, humanId, agentId: agent.id, conversationId: spare.id }),
		).rejects.toThrow()
		await expect(
			db
				.insert(masterChats)
				.values({ workspaceId, humanId, agentId: other.id, conversationId: chat.id }),
		).rejects.toThrow()
		expect(await rowsFor(workspaceId)).toHaveLength(1)
	})

	it('goes away with its conversation', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const chat = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)

		await db.delete(conversations).where(eq(conversations.id, chat?.id as string))

		expect(await rowsFor(workspaceId)).toEqual([])
	})
})

describe('wouldWidenMasterChat', () => {
	it('is true only for someone outside the pair, and only for a master chat', async () => {
		const { humanId, workspaceId, agent } = await setup()
		const third = await insertActor(db, { type: 'human' })
		const chat = await findOrCreateMasterChat(db, workspaceId, humanId, agent.id)
		const topical = await insertConversation(db, workspaceId, humanId)
		if (!chat || !topical) throw new Error('failed to seed')

		expect(await findMasterChatPair(db, chat.id)).toEqual({ humanId, agentId: agent.id })
		expect(await wouldWidenMasterChat(db, chat.id, [third.id])).toBe(true)
		expect(await wouldWidenMasterChat(db, chat.id, [agent.id, third.id])).toBe(true)
		expect(await wouldWidenMasterChat(db, chat.id, [humanId, agent.id])).toBe(false)
		expect(await wouldWidenMasterChat(db, chat.id, [])).toBe(false)
		expect(await wouldWidenMasterChat(db, topical.id, [third.id])).toBe(false)
	})
})
