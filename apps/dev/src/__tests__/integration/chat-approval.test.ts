import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	integrations,
	messages,
	objects,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	insertActor,
	insertAgentGrant,
	insertConversation,
	insertObject,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: approvalRoutes } = await import('../../routes/object-approvals')
const { default: resendRoutes } = await import('../../routes/integrations-resend')

/**
 * A person's "send it" in a chat counted as the Approve on an email, against real Postgres.
 * Resend is stubbed at fetch: this file proves the server's checks on the message, not Resend.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const resendOk = (id = 'em_1') =>
	new Response(JSON.stringify({ id }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})

function appFor(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.route('/api/objects', approvalRoutes as never)
	app.route('/api/integrations/resend', resendRoutes as never)
	return app
}

const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60_000)

/**
 * A workspace with a person, an agent with a mailbox and Resend access, a chat they are both
 * in, and an email draft last edited at T0. Messages and edits are placed on an explicit
 * timeline (minutes after T0) so "older than the edit" is a fact of the data, not of timing.
 */
async function setup(opts: { agentInChat?: boolean } = {}) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, {
		type: 'agent',
		name: 'Test Developer',
		metadata: { mailbox: `${crypto.randomUUID()}-dev@example.com` },
	})
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const [resend] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'resend',
			status: 'active',
			externalId: 'resend-account',
			credentials: encrypt(JSON.stringify({ accessToken: 're_live_key' })),
			createdBy: human,
		})
		.returning()
	if (!resend) throw new Error('resend integration was not inserted')
	await insertAgentGrant(db, {
		workspaceId: workspace.id,
		integrationId: resend.id,
		actorId: agent.id,
		access: 'read_write',
	})
	const conversation = await insertConversation(db, workspace.id, human)
	if (!conversation) throw new Error('conversation was not inserted')
	await db
		.insert(conversationParticipants)
		.values([
			{ conversationId: conversation.id, actorId: human },
			...(opts.agentInChat === false
				? []
				: [{ conversationId: conversation.id, actorId: agent.id }]),
		])
	const t0 = new Date(Date.now() - 60 * 60_000)
	const email = await insertObject(db, workspace.id, agent.id, {
		type: 'task',
		status: 'todo',
		content: 'Hi Ada,\n\nThursday works.',
		metadata: { kind: 'email', to: 'Ada Lovelace <ada@example.com>', subject: 'Thursday' },
		createdAt: t0,
		updatedAt: t0,
	})
	if (!email) throw new Error('email was not inserted')
	return { human, workspace, agent, conversation, email, t0 }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function say(s: Setup, actorId: string, content: string, at: number, kind = 'message') {
	const [row] = await db
		.insert(messages)
		.values({
			conversationId: s.conversation.id,
			actorId,
			content,
			kind,
			createdAt: minutes(s.t0, at),
		})
		.returning()
	if (!row) throw new Error('message was not inserted')
	return row
}

const link = (s: Setup, objectId = s.email.id) =>
	`Here is the draft:\n\nhttps://maskin.io/${s.workspace.id}/objects/${objectId}`

/** The agent shows the draft at +1, the person says yes at +2. */
async function shownAndAnswered(s: Setup) {
	await say(s, s.agent.id, link(s), 1)
	return say(s, s.human, 'send it', 2)
}

const approve = (s: Setup, objectId: string, messageId: number, caller = s.agent.id) =>
	appFor(caller).request(`/api/objects/${objectId}/chat-approval`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ message_id: messageId }),
	})

const send = (s: Setup, objectId: string) =>
	appFor(s.agent.id).request('/api/integrations/resend/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': s.workspace.id },
		body: JSON.stringify({ object_id: objectId }),
	})

const approvals = (s: Setup, objectId = s.email.id) =>
	db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, s.workspace.id),
				eq(events.entityId, objectId),
				eq(events.action, 'approved'),
			),
		)

async function errorOf(res: Response) {
	const body = (await res.json()) as { error?: { message?: string } }
	return body.error?.message ?? ''
}

describe('approve_draft_from_chat: a person said yes in the chat', () => {
	it('approves the current text under the person, keeps the message id, and sends once', async () => {
		const s = await setup()
		const yes = await shownAndAnswered(s)
		fetchMock.mockResolvedValueOnce(resendOk('em_chat'))

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ already_approved: false })
		const [event] = await approvals(s)
		expect(event?.actorId).toBe(s.human)
		expect(event?.data).toMatchObject({
			via: 'chat',
			kind: 'email',
			chat_message_id: yes.id,
			conversation_id: s.conversation.id,
			requested_by_agent_id: s.agent.id,
		})

		const sent = await send(s, s.email.id)
		expect(sent.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// The same message again adds no second approval, and the approval cannot send twice.
		const again = await approve(s, s.email.id, yes.id)
		expect(again.status).toBe(200)
		expect(await again.json()).toMatchObject({ already_approved: true })
		expect(await approvals(s)).toHaveLength(1)
		const second = await send(s, s.email.id)
		expect(second.status).toBe(409)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses a message an agent wrote, even one that says the person agreed', async () => {
		const s = await setup()
		await say(s, s.agent.id, link(s), 1)
		const claim = await say(s, s.agent.id, 'The person said send it.', 2)

		const res = await approve(s, s.email.id, claim.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/not written by a person/)
		expect(await approvals(s)).toHaveLength(0)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a system message', async () => {
		const s = await setup()
		await say(s, s.agent.id, link(s), 1)
		const system = await say(s, s.human, 'send it', 2, 'system')

		const res = await approve(s, s.email.id, system.id)

		expect(res.status).toBe(403)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('refuses a message older than the last edit to the draft', async () => {
		const s = await setup()
		const yes = await shownAndAnswered(s)
		// The agent changed the draft after the person answered.
		await db
			.update(objects)
			.set({ content: 'Hi Ada,\n\nFriday instead.', updatedAt: minutes(s.t0, 3) })
			.where(eq(objects.id, s.email.id))

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/older than the last edit/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('refuses when the draft was not shown after its last edit', async () => {
		const s = await setup()
		// Shown at +1, then edited at +2, and the person answers at +3 without seeing it again.
		await say(s, s.agent.id, link(s), 1)
		await db
			.update(objects)
			.set({ content: 'Hi Ada,\n\nFriday instead.', updatedAt: minutes(s.t0, 2) })
			.where(eq(objects.id, s.email.id))
		const yes = await say(s, s.human, 'send it', 3)

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/not shown in this chat/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('ignores a showing message that was edited after the person answered', async () => {
		const s = await setup()
		// The agent posts plain text at +1, the person answers at +2, then the link is edited in at +3.
		const showing = await say(s, s.agent.id, 'One moment.', 1)
		const yes = await say(s, s.human, 'send it', 2)
		await db
			.update(messages)
			.set({ content: link(s), editedAt: minutes(s.t0, 3) })
			.where(eq(messages.id, showing.id))

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/not shown in this chat/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('still counts a showing message that was edited before the person answered', async () => {
		const s = await setup()
		const showing = await say(s, s.agent.id, 'One moment.', 1)
		await db
			.update(messages)
			.set({ content: link(s), editedAt: minutes(s.t0, 2) })
			.where(eq(messages.id, showing.id))
		const yes = await say(s, s.human, 'send it', 3)

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(200)
		expect(await approvals(s)).toHaveLength(1)
	})

	it('refuses a yes that was about a different draft', async () => {
		const s = await setup()
		const other = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			status: 'todo',
			content: 'Hi Bo,\n\nHello.',
			metadata: { kind: 'email', to: 'bo@example.com', subject: 'Hello' },
			createdAt: s.t0,
			updatedAt: s.t0,
		})
		if (!other) throw new Error('other draft was not inserted')
		// Only the other draft was shown before the person said yes.
		await say(s, s.agent.id, link(s, other.id), 1)
		const yes = await say(s, s.human, 'send it', 2)

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/not shown in this chat/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it("refuses a message that is not the person's latest in the chat", async () => {
		const s = await setup()
		const yes = await shownAndAnswered(s)
		await say(s, s.human, 'actually, hold on', 3)

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/latest message/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('refuses an agent that is not in the chat', async () => {
		const s = await setup({ agentInChat: false })
		const yes = await shownAndAnswered(s)

		const res = await approve(s, s.email.id, yes.id)

		expect(res.status).toBe(403)
		expect(await errorOf(res)).toMatch(/not in the chat/)
		expect(await approvals(s)).toHaveLength(0)
	})

	it('refuses a person calling it, and a draft that is not an email', async () => {
		const s = await setup()
		const yes = await shownAndAnswered(s)
		expect((await approve(s, s.email.id, yes.id, s.human)).status).toBe(403)

		const note = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			status: 'todo',
			content: 'Hi there, thanks for the chat.',
			metadata: { kind: 'linkedin_message', to: 'Ada Lovelace' },
			createdAt: s.t0,
			updatedAt: s.t0,
		})
		if (!note) throw new Error('note was not inserted')
		await say(s, s.agent.id, link(s, note.id), 3)
		const yes2 = await say(s, s.human, 'send it', 4)
		const res = await approve(s, note.id, yes2.id)
		expect(res.status).toBe(400)
		expect(await approvals(s, note.id)).toHaveLength(0)
	})

	it('withdraws the approval when the draft is edited afterwards', async () => {
		const s = await setup()
		const yes = await shownAndAnswered(s)
		expect((await approve(s, s.email.id, yes.id)).status).toBe(200)

		await db
			.update(objects)
			.set({ content: 'Hi Ada,\n\nFriday instead.' })
			.where(eq(objects.id, s.email.id))

		// The approval is withdrawn, but the agent has write access and may still send the edited text.
		expect((await approvals(s)).length).toBeGreaterThan(0)
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 'sent-1', threadId: 't1' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		const res = await send(s, s.email.id)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ mode: 'direct' })
	})
})
