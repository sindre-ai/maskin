import { conversationParticipants, conversations } from '@maskin/db/schema'
import { loadActiveSessionsNote } from '../../services/spawned-sessions'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * A chat turn is told which sessions are already queued, starting or running for
 * the agents in the chat, so an agent does not start a duplicate of work a
 * mention or a trigger already put in motion.
 */
describe('Active sessions note for a chat turn (Integration)', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let outsiderId: string
	let conversationId: string

	beforeEach(async () => {
		await sql`TRUNCATE conversations CASCADE`
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent', name: 'Chat Agent' })
		const outsider = await insertActor(db, { type: 'agent', name: 'Outside Agent' })
		if (!human || !agent || !outsider) throw new Error('failed to seed actors')
		humanId = human.id
		agentId = agent.id
		outsiderId = outsider.id
		const workspace = await insertWorkspace(db, humanId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Active sessions chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id
		await db.insert(conversationParticipants).values([
			{ conversationId, actorId: humanId },
			{ conversationId, actorId: agentId },
		])
	})

	it('lists a trigger-started session of a chat agent', async () => {
		const started = await insertSession(db, workspaceId, agentId, agentId, {
			status: 'starting',
			conversationId: null,
			actionPrompt: 'Validate the task',
		})
		if (!started) throw new Error('no session')

		const note = await loadActiveSessionsNote(db, { conversationId, workspaceId })

		expect(note).toContain('Chat Agent (starting')
		expect(note).toContain(started.id)
		expect(note).toContain('Validate the task')
	})

	it('lists a helper the chat started on an agent that is not in the chat', async () => {
		const chatSession = await insertSession(db, workspaceId, agentId, agentId, {
			status: 'running',
			conversationId,
		})
		if (!chatSession) throw new Error('no chat session')
		const helper = await insertSession(db, workspaceId, outsiderId, agentId, {
			status: 'running',
			conversationId: null,
			spawnedBySessionId: chatSession.id,
		})
		if (!helper) throw new Error('no helper')

		const note = await loadActiveSessionsNote(db, { conversationId, workspaceId })

		expect(note).toContain('Outside Agent (running')
		expect(note).toContain(helper.id)
		// The chat's own session is not background work.
		expect(note).not.toContain(chatSession.id)
	})

	it('leaves out finished sessions and agents unrelated to the chat', async () => {
		await insertSession(db, workspaceId, agentId, agentId, {
			status: 'completed',
			conversationId: null,
		})
		await insertSession(db, workspaceId, outsiderId, agentId, {
			status: 'running',
			conversationId: null,
		})

		const note = await loadActiveSessionsNote(db, { conversationId, workspaceId })

		expect(note).toBe('')
	})
})
