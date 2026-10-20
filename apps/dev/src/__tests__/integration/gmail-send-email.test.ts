import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, messages, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	insertActor,
	insertAgentGrant,
	insertConversation,
	insertObject,
	insertRelationship,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')

/**
 * The Gmail send route against real Postgres. Gmail itself is stubbed at `fetch`: this
 * file proves our rules (who may send, to whom, what exactly goes out, how often), not
 * that Gmail behaves as assumed, which needs a live account.
 *
 * Real rows matter here: write access is a join over agent_grants, the protected-contact
 * guard is a jsonb lookup plus a works_at join, the approval check reads the audit log,
 * and the one-send-per-draft claim is a conditional UPDATE.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const gmailOk = (id = 'sent-1') =>
	new Response(JSON.stringify({ id, threadId: 't1' }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})
const gmailError = (status: number, message: string) =>
	new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

/** The message Maskin handed to Gmail, decoded. */
function sentMime(): string {
	const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string }
	return Buffer.from(JSON.parse(init.body).raw as string, 'base64url').toString('utf8')
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.route('/api/integrations/gmail', gmailRoutes as never)
	return app
}

function post(actorId: string, workspaceId: string, body: Record<string, unknown>) {
	return appFor(actorId).request('/api/integrations/gmail/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

const DIRECT = { to: 'ada@example.com', subject: 'Intro', body: 'Hi Ada' }

/** A workspace with Gmail connected, a person, and an agent that has (or lacks) write access. */
async function setup(opts: { agentAccess?: 'read' | 'read_write' | null } = {}) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const [gmail] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'gmail',
			status: 'active',
			externalId: 'sender@example.com',
			credentials: encrypt(
				JSON.stringify({ accessToken: 'live-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: human,
		})
		.returning()
	if (!gmail) throw new Error('gmail integration was not inserted')
	const access = opts.agentAccess === undefined ? 'read_write' : opts.agentAccess
	if (access) {
		await insertAgentGrant(db, {
			workspaceId: workspace.id,
			integrationId: gmail.id,
			actorId: agent.id,
			access,
		})
	}
	return { human, workspace, agent, gmail }
}

async function insertContact(
	workspaceId: string,
	human: string,
	metadata: Record<string, unknown>,
) {
	return insertObject(db, workspaceId, human, { type: 'contact', status: 'new_lead', metadata })
}

/** What `post_draft` leaves behind once a person has approved the card. */
async function insertApprovedDraft(
	s: Awaited<ReturnType<typeof setup>>,
	opts: { approvedBy?: string; to?: string; state?: 'draft' | 'approved' } = {},
) {
	const draft = await insertObject(db, s.workspace.id, s.agent.id, {
		type: 'task',
		status: 'in_review',
		content: 'Approved text, edited by the person',
		metadata: {
			draft_state: opts.state ?? 'approved',
			draft_subject: 'Approved subject',
			draft_original_subject: 'Original subject',
			draft_original_body: 'Original text from the agent',
		},
	})
	await db.insert(events).values({
		workspaceId: s.workspace.id,
		actorId: opts.approvedBy ?? s.human,
		action: 'updated',
		entityType: 'task',
		entityId: draft.id,
		data: { draft_action: 'approve' },
	})
	const conversation = await insertConversation(db, s.workspace.id, s.human)
	await db.insert(messages).values({
		conversationId: conversation.id,
		actorId: s.agent.id,
		content: 'Draft email',
		metadata: {
			draft: {
				object_id: draft.id,
				kind: 'email',
				to: opts.to ?? 'Mette Holm <mette@northwind.dk>',
			},
		},
	})
	return draft
}

const sendEvents = async (workspaceId: string, integrationId: string) =>
	db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, integrationId),
				eq(events.entityType, 'integration'),
			),
		)

const draftMeta = async (id: string) =>
	((await db.select().from(objects).where(eq(objects.id, id)))[0]?.metadata ?? {}) as Record<
		string,
		unknown
	>

describe('gmail_send_email: who may send', () => {
	it('lets an agent with write access send on its own, and records it', async () => {
		const s = await setup()
		fetchMock.mockResolvedValueOnce(gmailOk())

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 'sent-1', mode: 'direct' })
		expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer live-token')
		expect(sentMime()).toContain('To: ada@example.com')
		const rows = await sendEvents(s.workspace.id, s.gmail.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ actorId: s.agent.id, action: 'updated' })
		expect(rows[0]?.data).toMatchObject({
			gmail_action: 'sent',
			mode: 'direct',
			message_id: 'sent-1',
		})
	})

	it('refuses an agent that can only read Gmail, and sends nothing', async () => {
		const s = await setup({ agentAccess: 'read' })

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(403)
		expect(JSON.stringify(await res.json())).toContain('needs write access to Gmail')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await sendEvents(s.workspace.id, s.gmail.id)).toHaveLength(0)
	})

	it('refuses an agent with no grant when the integration default is read-only', async () => {
		const s = await setup({ agentAccess: null })

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('returns 404 when Gmail is not connected', async () => {
		const human = getTestActorId()
		const workspace = await insertWorkspace(db, human)

		expect((await post(human, workspace.id, DIRECT)).status).toBe(404)
	})
})

describe('gmail_send_email: protected recipients need a person', () => {
	it.each([
		['a protected contact', { protected: true }],
		['a contact whose protected flag is the string "true"', { protected: 'true' }],
		['a contact who opted out of email', { email_opt_out: true }],
		['a protected personal contact', { loss_category: 'personal_protected' }],
	])('refuses %s and says how to get it approved', async (_label, marks) => {
		const s = await setup()
		await insertContact(s.workspace.id, s.human, { email: 'Ada@Example.com', ...marks })

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(403)
		const text = JSON.stringify(await res.json())
		expect(text).toContain('ada@example.com')
		expect(text).toContain('post_draft')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a contact who works at a protected company', async () => {
		const s = await setup()
		const contact = await insertContact(s.workspace.id, s.human, { email: 'ada@example.com' })
		const company = await insertObject(db, s.workspace.id, s.human, {
			type: 'company',
			status: 'prospect',
			metadata: { protected: true },
		})
		await insertRelationship(db, s.human, {
			sourceType: 'object',
			sourceId: contact.id,
			targetType: 'object',
			targetId: company.id,
			type: 'works_at',
		})

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(403)
		expect(JSON.stringify(await res.json())).toContain('protected')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses when any one of several recipients is protected', async () => {
		const s = await setup()
		await insertContact(s.workspace.id, s.human, { email: 'noor@example.com', protected: true })

		const res = await post(s.agent.id, s.workspace.id, {
			...DIRECT,
			to: 'ada@example.com',
			cc: 'noor@example.com',
		})

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends to an unmarked contact, and to someone who is not a contact at all', async () => {
		const s = await setup()
		await insertContact(s.workspace.id, s.human, { email: 'ada@example.com', protected: false })
		fetchMock.mockImplementation(async () => gmailOk())

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(200)
		expect(
			(await post(s.agent.id, s.workspace.id, { ...DIRECT, to: 'stranger@example.org' })).status,
		).toBe(200)
	})

	it("ignores another workspace's protected contact", async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)
		await insertContact(other.id, s.human, { email: 'ada@example.com', protected: true })
		fetchMock.mockResolvedValueOnce(gmailOk())

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(200)
	})
})

describe('gmail_send_email: an approved draft', () => {
	it('sends exactly the saved subject and text to the card address, even for a protected contact', async () => {
		const s = await setup()
		await insertContact(s.workspace.id, s.human, { email: 'mette@northwind.dk', protected: true })
		const draft = await insertApprovedDraft(s)
		fetchMock.mockResolvedValueOnce(gmailOk('sent-9'))

		const res = await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 'sent-9', mode: 'approved_draft' })
		const mime = sentMime()
		expect(mime).toContain('To: Mette Holm <mette@northwind.dk>')
		expect(mime).toContain('Subject: Approved subject')
		const body = mime.split('\r\n\r\n')[1] ?? ''
		expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
			'Approved text, edited by the person',
		)
		expect(await draftMeta(draft.id)).toMatchObject({
			draft_send_state: 'sent',
			draft_sent_message_id: 'sent-9',
		})
	})

	it('sends it once: a second call is refused and Gmail is not called again', async () => {
		const s = await setup()
		const draft = await insertApprovedDraft(s)
		fetchMock.mockImplementation(async () => gmailOk())

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })).status).toBe(200)
		const again = await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })

		expect(again.status).toBe(409)
		expect(JSON.stringify(await again.json())).toContain('already sent')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('lets only one of two simultaneous calls send', async () => {
		const s = await setup()
		const draft = await insertApprovedDraft(s)
		fetchMock.mockImplementation(async () => gmailOk())

		const results = await Promise.all([
			post(s.agent.id, s.workspace.id, { draft_object_id: draft.id }),
			post(s.agent.id, s.workspace.id, { draft_object_id: draft.id }),
		])

		expect(results.map((r) => r.status).sort()).toEqual([200, 409])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses a draft that is still a draft', async () => {
		const s = await setup()
		const draft = await insertApprovedDraft(s, { state: 'draft' })

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })).status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft that an agent approved: only a person can', async () => {
		const s = await setup()
		const draft = await insertApprovedDraft(s, { approvedBy: s.agent.id })

		const res = await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('not approved by a person')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a card whose recipient has no email address, and says to redraft', async () => {
		const s = await setup()
		const draft = await insertApprovedDraft(s, { to: 'Mette Holm, Northwind' })

		const res = await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('Post a new draft')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('still needs write access', async () => {
		const s = await setup({ agentAccess: 'read' })
		const draft = await insertApprovedDraft(s)

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })).status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not read a draft from another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const draft = await insertApprovedDraft(other)

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: draft.id })).status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('frees the draft when Gmail refuses it, and locks it when the outcome is unknown', async () => {
		const s = await setup()
		const refused = await insertApprovedDraft(s)
		const unknown = await insertApprovedDraft(s)
		fetchMock
			.mockResolvedValueOnce(gmailError(400, 'Invalid To header'))
			.mockResolvedValueOnce(gmailError(503, 'Backend Error'))

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: refused.id })).status).toBe(
			422,
		)
		expect(await draftMeta(refused.id)).not.toHaveProperty('draft_send_state')

		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: unknown.id })).status).toBe(
			502,
		)
		expect(await draftMeta(unknown.id)).toMatchObject({ draft_send_state: 'unknown' })
		// Sending again could deliver it twice, so it stays locked until a person looks.
		expect((await post(s.agent.id, s.workspace.id, { draft_object_id: unknown.id })).status).toBe(
			409,
		)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

describe('gmail_send_email: a retry does not send twice', () => {
	it('refuses the same email within 24 hours', async () => {
		const s = await setup()
		fetchMock.mockImplementation(async () => gmailOk())

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(200)
		const again = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(again.status).toBe(409)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('allows a different email to the same person', async () => {
		const s = await setup()
		fetchMock.mockImplementation(async () => gmailOk())

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(200)
		expect(
			(await post(s.agent.id, s.workspace.id, { ...DIRECT, body: 'A different note' })).status,
		).toBe(200)
	})
})

describe('gmail_send_email: input', () => {
	it('rejects a header-injection attempt in the recipient', async () => {
		const s = await setup()

		const res = await post(s.agent.id, s.workspace.id, {
			...DIRECT,
			to: 'ada@example.com\r\nBcc: boss@example.com',
		})

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a call that mixes a draft with new content', async () => {
		const s = await setup()

		const res = await post(s.agent.id, s.workspace.id, {
			...DIRECT,
			draft_object_id: '11111111-1111-4111-8111-111111111111',
		})

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a call with nothing to send', async () => {
		const s = await setup()

		expect((await post(s.agent.id, s.workspace.id, { to: 'ada@example.com' })).status).toBe(400)
	})
})
