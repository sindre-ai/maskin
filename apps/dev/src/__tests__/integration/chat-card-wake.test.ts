import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
	insertActor,
	insertConversation,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: approvalRoutes } = await import('../../routes/object-approvals')
const { default: objectRoutes } = await import('../../routes/objects')

/**
 * Approving a draft or moving its status from a card in a chat tells the agent behind the
 * card on the server: a turn written into its chat session, and no message in the chat in
 * the person's name. Real Postgres, so the "no message" claim is a read of the table.
 */

function appFor(actorId: string, sessionManager: unknown) {
	const app = new OpenAPIHono<{
		Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/objects', approvalRoutes as never)
	app.route('/api/objects', objectRoutes as never)
	return app
}

async function setup({ agentInChat = true } = {}) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const conversation = await insertConversation(db, workspace.id, human)
	if (!conversation) throw new Error('conversation was not inserted')
	await db
		.insert(conversationParticipants)
		.values([
			{ conversationId: conversation.id, actorId: human },
			...(agentInChat ? [{ conversationId: conversation.id, actorId: agent.id }] : []),
		])
	const draft = await insertObject(db, workspace.id, agent.id, {
		type: 'task',
		status: 'todo',
		content: 'Hi Ada,\n\nThursday works.',
		metadata: { kind: 'email', to: 'Ada Lovelace <ada@example.com>', subject: 'Thursday' },
	})
	if (!draft) throw new Error('draft was not inserted')
	// The agent's message that holds the card.
	const [cardMessage] = await db
		.insert(messages)
		.values({
			conversationId: conversation.id,
			actorId: agent.id,
			content: `Draft: https://maskin.io/${workspace.id}/objects/${draft.id}`,
		})
		.returning()
	if (!cardMessage) throw new Error('card message was not inserted')
	const session = await insertSession(db, workspace.id, agent.id, human, {
		status: 'running',
		interactive: true,
		conversationId: conversation.id,
	})
	if (!session) throw new Error('session was not inserted')

	// The agent's chat session is up, so the turn goes straight into it.
	const sessionManager = {
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(session),
		findActiveConversationSession: vi.fn().mockResolvedValue(session),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	const chat = { conversation_id: conversation.id, agent_id: agent.id }
	return {
		human,
		workspace,
		agent,
		conversation,
		draft,
		cardMessage,
		session,
		sessionManager,
		chat,
	}
}

type Setup = Awaited<ReturnType<typeof setup>>

const messageCount = async (s: Setup) =>
	(await db.select().from(messages).where(eq(messages.conversationId, s.conversation.id))).length

const post = (s: Setup, path: string, method: string, body: Record<string, unknown>) =>
	appFor(s.human, s.sessionManager).request(path, {
		method,
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': s.workspace.id },
		body: JSON.stringify(body),
	})

const contentHash = async (s: Setup) => {
	const res = await appFor(s.human, s.sessionManager).request(`/api/objects/${s.draft.id}`, {
		headers: { 'X-Workspace-Id': s.workspace.id },
	})
	return ((await res.json()) as { preview: { content_hash: string } }).preview.content_hash
}

const writtenTurn = (s: Setup) => {
	const call = s.sessionManager.writeInput.mock.calls[0] as unknown as [
		string,
		{ message: { content: string } },
		unknown,
		number,
	]
	return { sessionId: call[0], content: call[1].message.content, anchor: call[3] }
}

describe('chat card wake', () => {
	it('tells the agent to send an approved draft and posts no message', async () => {
		const s = await setup()
		const before = await messageCount(s)

		const res = await post(s, `/api/objects/${s.draft.id}/approval`, 'POST', {
			content_hash: await contentHash(s),
			chat: s.chat,
		})
		expect(res.status).toBe(200)

		await vi.waitFor(() => expect(s.sessionManager.writeInput).toHaveBeenCalledTimes(1))
		const turn = writtenTurn(s)
		expect(turn.sessionId).toBe(s.session.id)
		expect(turn.content).toContain('Approved "')
		expect(turn.content).toContain('Send it exactly as it reads')
		expect(turn.content).toContain(`object_id ${s.draft.id}`)
		expect(turn.content).toContain('> Thursday works.')
		// Anchored after the agent's message that holds the card.
		expect(turn.anchor).toBe(s.cardMessage.id)
		expect(await messageCount(s)).toBe(before)
	})

	it('tells the agent about a status move and posts no message', async () => {
		const s = await setup()
		const before = await messageCount(s)

		const res = await post(s, `/api/objects/${s.draft.id}`, 'PATCH', {
			status: 'in_progress',
			chat: s.chat,
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as { status: string }).status).toBe('in_progress')

		await vi.waitFor(() => expect(s.sessionManager.writeInput).toHaveBeenCalledTimes(1))
		const turn = writtenTurn(s)
		expect(turn.content).toContain('to in_progress')
		expect(turn.content).toContain('> Thursday works.')
		expect(turn.anchor).toBe(s.cardMessage.id)
		expect(await messageCount(s)).toBe(before)
	})

	it('does not wake anyone when the status does not change', async () => {
		const s = await setup()
		const res = await post(s, `/api/objects/${s.draft.id}`, 'PATCH', {
			status: 'todo',
			chat: s.chat,
		})
		expect(res.status).toBe(200)
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(s.sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('does not wake an agent that is not in the chat', async () => {
		const s = await setup({ agentInChat: false })
		const res = await post(s, `/api/objects/${s.draft.id}/approval`, 'POST', {
			content_hash: await contentHash(s),
			chat: s.chat,
		})
		expect(res.status).toBe(200)
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(s.sessionManager.writeInput).not.toHaveBeenCalled()
		expect(s.sessionManager.findConversationSessionAnyActive).not.toHaveBeenCalled()
	})

	it('approves without waking anyone when no chat is named', async () => {
		const s = await setup()
		const res = await post(s, `/api/objects/${s.draft.id}/approval`, 'POST', {
			content_hash: await contentHash(s),
		})
		expect(res.status).toBe(200)
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(s.sessionManager.writeInput).not.toHaveBeenCalled()
	})
})
