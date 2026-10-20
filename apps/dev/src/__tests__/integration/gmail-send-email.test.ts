import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	insertActor,
	insertAgentGrant,
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
 * guard is a jsonb lookup plus a works_at join, and an approval is read back from the
 * `events` rows the For You card produces (the agent's decision comment, the person's reply).
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
async function setup(opts: { agentAccess?: 'read' | 'ask_first' | 'read_write' | null } = {}) {
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

type Setup = Awaited<ReturnType<typeof setup>>

const EMAIL_TEXT = 'Subject: Approved subject\n\nApproved text, edited by the person'

interface CardOptions {
	/** Who the card says the email goes to. */
	to?: string | null
	/** The draft text. */
	text?: string
	/** The text lives on an object (live, like the card shows it) or inline on the card. */
	inline?: boolean
	/** The options on the card; default is one destructive "Send it" and a "Hold". */
	options?: Array<{ label: string; destructive?: boolean }>
	/** Who answered, and with what. `[]` is nobody. */
	answers?: Array<{ by: 'human' | 'agent'; content: string }>
	/** The agent that posted it (default: the agent in setup). */
	postedBy?: string
}

/**
 * What the For You approval flow leaves behind: the agent's comment with a `decision` (the
 * draft attached), and the person's tap stored as a reply under it. The comment is on an
 * unrelated object, as it is in practice; the draft is a separate object.
 */
async function insertApprovalCard(s: Setup, opts: CardOptions = {}) {
	const anchor = await insertObject(db, s.workspace.id, s.human, { type: 'task' })
	const draftObject = opts.inline
		? null
		: await insertObject(db, s.workspace.id, s.agent.id, {
				type: 'task',
				content: opts.text ?? EMAIL_TEXT,
			})
	const options = opts.options ?? [{ label: 'Send it', destructive: true }, { label: 'Hold' }]
	const decision = {
		title: 'Send the intro email',
		summary: 'Ada has not heard from us in 14 days.',
		ask: 'I will not send this to a customer alone.',
		options: options.map((o) => ({
			label: o.label,
			consequences: ['Goes out now', 'Cannot be recalled'],
			...(o.destructive ? { destructive: true, recommended: true } : {}),
		})),
		draft: {
			...(draftObject ? { object_id: draftObject.id } : { body: opts.text ?? EMAIL_TEXT }),
			label: 'Email to Ada',
			...(opts.to === null ? {} : { to: opts.to ?? 'Ada Lovelace <ada@example.com>' }),
		},
	}
	const [card] = await db
		.insert(events)
		.values({
			workspaceId: s.workspace.id,
			actorId: opts.postedBy ?? s.agent.id,
			action: 'commented',
			entityType: 'object',
			entityId: anchor.id,
			data: { content: 'Please approve.', mentions: [s.human], decision },
		})
		.returning()
	if (!card) throw new Error('card was not inserted')
	const answers = opts.answers ?? [{ by: 'human', content: 'Send it' }]
	for (const a of answers) {
		await db.insert(events).values({
			workspaceId: s.workspace.id,
			actorId: a.by === 'human' ? s.human : s.agent.id,
			action: 'commented',
			entityType: 'object',
			entityId: anchor.id,
			data: { content: a.content, parentEventId: card.id },
		})
	}
	return { card, draftObject }
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

const gmailActions = async (workspaceId: string, integrationId: string) =>
	(await sendEvents(workspaceId, integrationId)).map(
		(e) => (e.data as { gmail_action?: string }).gmail_action,
	)

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

describe('gmail_send_email: the three modes', () => {
	it('"Ask first" refuses a direct send and says how to get it approved', async () => {
		const s = await setup({ agentAccess: 'ask_first' })

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(403)
		const text = JSON.stringify(await res.json())
		expect(text).toContain('Ask first')
		expect(text).toContain('decision')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await sendEvents(s.workspace.id, s.gmail.id)).toHaveLength(0)
	})

	it('"Ask first" sends an email a person approved', async () => {
		const s = await setup({ agentAccess: 'ask_first' })
		const { card } = await insertApprovalCard(s)
		fetchMock.mockResolvedValueOnce(gmailOk('sent-7'))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 'sent-7', mode: 'approved_draft' })
	})

	it('"Ask first" still cannot send when nobody has answered', async () => {
		const s = await setup({ agentAccess: 'ask_first' })
		const { card } = await insertApprovalCard(s, { answers: [] })

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			409,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('"Read" cannot send at all, not even an approved email', async () => {
		const s = await setup({ agentAccess: 'read' })
		const { card } = await insertApprovalCard(s)

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			403,
		)
		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('"Read & write" sends directly, to a recipient nobody marked', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		fetchMock.mockResolvedValueOnce(gmailOk())

		expect((await post(s.agent.id, s.workspace.id, DIRECT)).status).toBe(200)
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
		expect(text).toContain('decision')
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

	it('sends to a protected contact once a person has approved that email', async () => {
		const s = await setup()
		await insertContact(s.workspace.id, s.human, { email: 'ada@example.com', protected: true })
		const { card } = await insertApprovalCard(s)
		fetchMock.mockResolvedValueOnce(gmailOk())

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			200,
		)
	})
})

describe('gmail_send_email: an approved email', () => {
	it('sends exactly the draft the card shows, to the address on the card', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, {
			to: 'Mette Holm <mette@northwind.dk>',
			text: 'Subject: Following up\n\nHi Mette,\nThe note you asked for.',
		})
		fetchMock.mockResolvedValueOnce(gmailOk('sent-9'))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 'sent-9', mode: 'approved_draft' })
		const mime = sentMime()
		expect(mime).toContain('To: Mette Holm <mette@northwind.dk>')
		expect(mime).toContain('Subject: Following up')
		const body = mime.split('\r\n\r\n')[1] ?? ''
		expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
			'Hi Mette,\r\nThe note you asked for.',
		)
		const rows = await sendEvents(s.workspace.id, s.gmail.id)
		expect(rows.map((r) => r.data)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gmail_action: 'sent',
					mode: 'approved_draft',
					approval_comment_id: card.id,
				}),
			]),
		)
	})

	it('sends a draft that is stored on the card rather than on an object', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { inline: true })
		fetchMock.mockResolvedValueOnce(gmailOk())

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			200,
		)
		expect(sentMime()).toContain('Subject: Approved subject')
	})

	it('sends it once: a second call is refused and Gmail is not called again', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		fetchMock.mockImplementation(async () => gmailOk())

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			200,
		)
		const again = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(again.status).toBe(409)
		expect(JSON.stringify(await again.json())).toContain('already used')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('lets only one of several simultaneous calls send', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		fetchMock.mockImplementation(async () => gmailOk())

		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				post(s.agent.id, s.workspace.id, { approval_comment_id: card.id }),
			),
		)

		expect(results.filter((r) => r.status === 200)).toHaveLength(1)
		expect(results.filter((r) => r.status === 409)).toHaveLength(5)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('refuses a card nobody has answered', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { answers: [] })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('No person has answered')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses when the person chose another option', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { answers: [{ by: 'human', content: 'Hold' }] })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'chose "Hold"',
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('counts the latest answer: a person who said send and then hold has said hold', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, {
			answers: [
				{ by: 'human', content: 'Send it' },
				{ by: 'human', content: 'Hold' },
			],
		})

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			409,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not count an agent answering its own card', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { answers: [{ by: 'agent', content: 'Send it' }] })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('No person has answered')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("does not let an agent send on another agent's card", async () => {
		const s = await setup()
		const other = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.workspace.id, actorId: other.id, role: 'member' })
		await insertAgentGrant(db, {
			workspaceId: s.workspace.id,
			integrationId: s.gmail.id,
			actorId: other.id,
			access: 'read_write',
		})
		const { card } = await insertApprovalCard(s)

		expect((await post(other.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			409,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft that was changed after the person approved it', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db
			.update(objects)
			.set({
				content: 'Subject: Different\n\nSomething else entirely',
				updatedAt: new Date(Date.now() + 5000),
			})
			.where(eq(objects.id, draftObject?.id as string))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('changed after the person approved')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses when a logged edit changed the text after the person approved it', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db.insert(events).values({
			workspaceId: s.workspace.id,
			actorId: s.agent.id,
			action: 'updated',
			entityType: 'task',
			entityId: draftObject?.id as string,
			data: { changes: [{ field: 'content', old: EMAIL_TEXT, new: 'Subject: Other\n\nElse' }] },
		})

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('changed after the person approved')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('still sends when only the status or driver moved after the approval', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db
			.update(objects)
			.set({ status: 'in_progress', updatedAt: new Date(Date.now() + 5000) })
			.where(eq(objects.id, draftObject?.id as string))
		await db.insert(events).values({
			workspaceId: s.workspace.id,
			actorId: s.human,
			action: 'status_changed',
			entityType: 'task',
			entityId: draftObject?.id as string,
			data: { changes: [{ field: 'status', old: 'todo', new: 'in_progress' }] },
		})
		fetchMock.mockResolvedValueOnce(gmailOk())

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(sentMime()).toContain('Subject: Approved subject')
	})

	it('refuses when the object moved on and nothing logged why', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db
			.update(objects)
			.set({ updatedAt: new Date(Date.now() + 5000) })
			.where(eq(objects.id, draftObject?.id as string))

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			409,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends the text as the person left it when they edited it before approving', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		// The edit happened before the tap: the reply is later than the object's last change.
		await db
			.update(objects)
			.set({
				content: 'Subject: Edited by Sebastian\n\nTighter wording',
				updatedAt: new Date(Date.now() - 60_000),
			})
			.where(eq(objects.id, draftObject?.id as string))
		fetchMock.mockResolvedValueOnce(gmailOk())

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(sentMime()).toContain('Subject: Edited by Sebastian')
	})

	it.each([
		['no destructive option', [{ label: 'Send it' }, { label: 'Hold' }]],
		[
			'two destructive options',
			[
				{ label: 'Send it', destructive: true },
				{ label: 'Send and cc', destructive: true },
				{ label: 'Hold' },
			],
		],
	])('refuses a card with %s: it is not clear which option sends', async (_label, options) => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { options })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('exactly one option as destructive')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a card whose recipient has no email address, and says how to redraft', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { to: 'Ada Lovelace, Analytical Engines' })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('real address')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft with no Subject line, because the person approved the text they saw', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { text: 'Hi Ada, no subject here.' })

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('Subject:')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a comment that is not an approval card', async () => {
		const s = await setup()
		const anchor = await insertObject(db, s.workspace.id, s.human, { type: 'task' })
		const [plain] = await db
			.insert(events)
			.values({
				workspaceId: s.workspace.id,
				actorId: s.agent.id,
				action: 'commented',
				entityType: 'object',
				entityId: anchor.id,
				data: { content: 'Just a comment' },
			})
			.returning()

		expect(
			(await post(s.agent.id, s.workspace.id, { approval_comment_id: plain?.id as number })).status,
		).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('still needs write access', async () => {
		const s = await setup({ agentAccess: 'read' })
		const { card } = await insertApprovalCard(s)

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			403,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("does not read another workspace's card", async () => {
		const s = await setup()
		const other = await setup()
		const { card } = await insertApprovalCard(other)

		expect((await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })).status).toBe(
			404,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('frees the approval when Gmail refuses it, and locks it when the outcome is unknown', async () => {
		const s = await setup()
		const refused = await insertApprovalCard(s)
		const unknown = await insertApprovalCard(s)
		fetchMock
			.mockResolvedValueOnce(gmailError(400, 'Invalid To header'))
			.mockResolvedValueOnce(gmailOk('after-refusal'))
			.mockResolvedValueOnce(gmailError(503, 'Backend Error'))

		const first = await post(s.agent.id, s.workspace.id, { approval_comment_id: refused.card.id })
		expect(first.status).toBe(422)
		// Gmail refused it, so nothing went out and the same approval can be tried again.
		const retry = await post(s.agent.id, s.workspace.id, { approval_comment_id: refused.card.id })
		expect(retry.status).toBe(200)

		expect(
			(await post(s.agent.id, s.workspace.id, { approval_comment_id: unknown.card.id })).status,
		).toBe(502)
		// Sending again could deliver it twice, so it stays locked until a person looks.
		const locked = await post(s.agent.id, s.workspace.id, { approval_comment_id: unknown.card.id })
		expect(locked.status).toBe(409)
		expect(JSON.stringify(await locked.json())).toContain('Sent folder')
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(await gmailActions(s.workspace.id, s.gmail.id)).toEqual(
			expect.arrayContaining(['send_released', 'sent', 'send_unknown']),
		)
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

	it('rejects a call that mixes an approval with new content', async () => {
		const s = await setup()

		const res = await post(s.agent.id, s.workspace.id, { ...DIRECT, approval_comment_id: 12345 })

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a call with nothing to send', async () => {
		const s = await setup()

		expect((await post(s.agent.id, s.workspace.id, { to: 'ada@example.com' })).status).toBe(400)
	})
})
