import { conversations, messages, sessions, voiceSessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { VoiceShowInChatError, showInChat } from '../../services/voice-show-in-chat'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function seedCall() {
	const humanId = getTestActorId()
	const agent = await insertActor(db, { type: 'agent', name: 'Chief of Staff', email: null })
	const ws = await insertWorkspace(db, humanId)
	const [session] = await db
		.insert(voiceSessions)
		.values({
			workspaceId: ws.id,
			agentActorId: agent.id,
			humanActorId: humanId,
			status: 'active',
		})
		.returning()
	if (!session) throw new Error('voice session insert failed')
	return { session, agent, ws, humanId }
}

const messagesOf = (conversationId: string) =>
	db.select().from(messages).where(eq(messages.conversationId, conversationId))

describe('show_in_chat against real Postgres', () => {
	it('posts one voice-tagged message as the agent into the call conversation', async () => {
		const { session, agent, ws, humanId } = await seedCall()
		const object = await insertObject(db, ws.id, humanId, { title: 'Reply to Anna' })

		const result = await showInChat({
			db,
			session,
			agentName: 'Chief of Staff',
			args: {
				object_ids: [object.id],
				links: [{ url: 'https://example.com/connect', label: 'Connect' }],
				caption: 'Take a look',
			},
			webAppBaseUrl: 'https://app.test',
		})

		// The call had no chat, so one was created and the call is pinned to it.
		const [pinned] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, session.id))
		expect(pinned?.conversationId).toBe(result.conversationId)

		const rows = await messagesOf(result.conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			actorId: agent.id,
			metadata: { source: 'voice', voice_session_id: session.id },
		})
		expect(rows[0]?.content).toContain(
			`[Reply to Anna](https://app.test/${ws.id}/objects/${object.id})`,
		)
		expect(rows[0]?.content).toContain('[Connect](https://example.com/connect)')
	})

	it('reuses the conversation the call is already pinned to', async () => {
		const { session, ws, humanId } = await seedCall()
		const object = await insertObject(db, ws.id, humanId)
		const first = await showInChat({
			db,
			session,
			agentName: 'A',
			args: { object_ids: [object.id] },
		})
		const second = await showInChat({
			db,
			session: { ...session, conversationId: null },
			agentName: 'A',
			args: { object_ids: [object.id] },
		})
		expect(second.conversationId).toBe(first.conversationId)
		expect(await messagesOf(first.conversationId)).toHaveLength(2)
	})

	it('refuses an object of another workspace and writes no message', async () => {
		const { session } = await seedCall()
		const other = await seedCall()
		const foreign = await insertObject(db, other.ws.id, other.humanId)

		await expect(
			showInChat({ db, session, agentName: 'A', args: { object_ids: [foreign.id] } }),
		).rejects.toBeInstanceOf(VoiceShowInChatError)

		const [after] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, session.id))
		expect(after?.conversationId).toBeNull()
		expect(
			await db
				.select()
				.from(conversations)
				.where(eq(conversations.workspaceId, session.workspaceId)),
		).toHaveLength(0)
	})

	it('refuses a list over the cap', async () => {
		const { session } = await seedCall()
		const links = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}` }))
		await expect(
			showInChat({ db, session, agentName: 'A', args: { links } }),
		).rejects.toBeInstanceOf(VoiceShowInChatError)
	})

	it('wakes no agent: it writes the message and the audit event, nothing else', async () => {
		const { session, ws, humanId } = await seedCall()
		const object = await insertObject(db, ws.id, humanId)
		await showInChat({ db, session, agentName: 'A', args: { object_ids: [object.id] } })
		expect(await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id))).toHaveLength(0)
	})
})
