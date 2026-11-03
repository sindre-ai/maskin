import { conversationParticipants, conversations, messages } from '@maskin/db/schema'
import {
	anchorSpawnedSessionsToMessage,
	canAnchorToMessage,
	loadSpawnedSessionsByMessage,
} from '../../services/spawned-sessions'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * A session handed off over REST carries `spawned_by_message_id` but never
 * `sessions.conversation_id`. The embed and the anchor gate must key on the
 * anchor message's conversation, or those handoffs never reach the chat.
 */
describe('Spawned sessions embed (Integration)', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let conversationId: string
	let messageId: number

	beforeEach(async () => {
		await sql`TRUNCATE messages, conversations CASCADE`
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })
		if (!human || !agent) throw new Error('failed to seed actors')
		humanId = human.id
		agentId = agent.id
		const workspace = await insertWorkspace(db, humanId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Embed test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id
		await db.insert(conversationParticipants).values([
			{ conversationId, actorId: humanId },
			{ conversationId, actorId: agentId },
		])
		const [message] = await db
			.insert(messages)
			.values({ conversationId, actorId: agentId, content: 'handing off' })
			.returning()
		if (!message) throw new Error('failed to seed message')
		messageId = message.id
	})

	it('embeds a sub-session anchored to the message even with no conversation_id', async () => {
		const sub = await insertSession(db, workspaceId, agentId, agentId, {
			interactive: false,
			conversationId: null,
			spawnedByMessageId: messageId,
			status: 'running',
		})
		if (!sub) throw new Error('no sub-session')

		const embed = await loadSpawnedSessionsByMessage(db, {
			conversationId,
			workspaceId,
			messageIds: [messageId],
			actorId: humanId,
		})
		expect(embed.get(messageId)?.map((s) => s.id)).toEqual([sub.id])
	})

	it('reports what a waiting sub-session is asking', async () => {
		const sub = await insertSession(db, workspaceId, agentId, agentId, {
			interactive: true,
			conversationId: null,
			spawnedByMessageId: messageId,
			status: 'running',
			config: { awaiting: { message_id: messageId, question: { session_id: 'x', questions: [] } } },
		})
		if (!sub) throw new Error('no sub-session')

		const embed = await loadSpawnedSessionsByMessage(db, {
			conversationId,
			workspaceId,
			messageIds: [messageId],
			actorId: humanId,
		})
		expect(embed.get(messageId)?.[0]?.awaiting?.message_id).toBe(messageId)
	})

	it('returns nothing to an actor who is not in the conversation', async () => {
		const stranger = await insertActor(db, { type: 'human' })
		if (!stranger) throw new Error('no stranger')
		await insertSession(db, workspaceId, agentId, agentId, {
			interactive: false,
			conversationId: null,
			spawnedByMessageId: messageId,
		})

		const embed = await loadSpawnedSessionsByMessage(db, {
			conversationId,
			workspaceId,
			messageIds: [messageId],
			actorId: stranger.id,
		})
		expect(embed.get(messageId)).toEqual([])
	})

	it('only lets a participant anchor to a message', async () => {
		const stranger = await insertActor(db, { type: 'agent' })
		if (!stranger) throw new Error('no stranger')

		expect(await canAnchorToMessage(db, { messageId, workspaceId, actorId: agentId })).toBe(true)
		expect(await canAnchorToMessage(db, { messageId, workspaceId, actorId: stranger.id })).toBe(
			false,
		)
		expect(await canAnchorToMessage(db, { messageId: 999999, workspaceId, actorId: agentId })).toBe(
			false,
		)
	})
	it('anchors sessions spawned since the agent previous message to the next one it posts', async () => {
		const chat = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!chat) throw new Error('no chat session')
		const sub = await insertSession(db, workspaceId, agentId, agentId, {
			interactive: false,
			conversationId: null,
			spawnedBySessionId: chat.id,
			spawnedByMessageId: null,
		})
		if (!sub) throw new Error('no sub-session')
		const [next] = await db
			.insert(messages)
			.values({ conversationId, actorId: agentId, content: 'Running a dry run now' })
			.returning()
		if (!next) throw new Error('no message')

		await anchorSpawnedSessionsToMessage(db, {
			spawnerSessionId: chat.id,
			conversationId,
			actorId: agentId,
			messageId: next.id,
		})

		const embed = await loadSpawnedSessionsByMessage(db, {
			conversationId,
			workspaceId,
			messageIds: [next.id],
			actorId: humanId,
		})
		expect(embed.get(next.id)?.map((s) => s.id)).toEqual([sub.id])
	})
})
