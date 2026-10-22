import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { approvedSendHashFor } from '../../lib/integrations/providers/gmail/approval-hash'
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
			data: {
				content: a.content,
				parentEventId: card.id,
				...(a.by === 'human'
					? { approved_send_hash: await approvedHash(s, card.id, a.content) }
					: {}),
			},
		})
	}
	return { card, draftObject }
}

/**
 * What the comment route stamps on a person's reply: the fingerprint of the draft as the card
 * shows it at that moment. Computed by the real function, so the tests and the route agree.
 */
async function approvedHash(s: Setup, cardId: number, content: string) {
	return approvedSendHashFor(db, s.workspace.id, cardId, content)
}

/** The person answers again, now: their reply is stamped with the draft as it reads at this moment. */
async function reanswer(s: Setup, cardId: number) {
	const replies = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.workspaceId, s.workspace.id),
				eq(events.action, 'commented'),
				sql`${events.data}->>'parentEventId' = ${String(cardId)}`,
				eq(events.actorId, s.human),
			),
		)
	for (const r of replies) {
		const content = (r.data as { content: string }).content
		await db
			.update(events)
			.set({
				data: { ...(r.data as object), approved_send_hash: await approvedHash(s, cardId, content) },
			})
			.where(eq(events.id, r.id))
	}
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
	it('sends an email a person approved, and records it', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		fetchMock.mockResolvedValueOnce(gmailOk())

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 'sent-1', mode: 'approved_draft' })
		expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer live-token')
		// The approval is claimed first (send_claim), then the send itself is recorded.
		const rows = (await sendEvents(s.workspace.id, s.gmail.id)).filter(
			(e) => (e.data as { gmail_action?: string }).gmail_action === 'sent',
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ actorId: s.agent.id, action: 'updated' })
		expect(rows[0]?.data).toMatchObject({
			gmail_action: 'sent',
			mode: 'approved_draft',
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

describe('gmail_send_email: Read & write still needs a person', () => {
	it('refuses a direct send, whoever the recipient is, and says how to get it approved', async () => {
		const s = await setup({ agentAccess: 'read_write' })

		const res = await post(s.agent.id, s.workspace.id, DIRECT)

		expect(res.status).toBe(403)
		const text = JSON.stringify(await res.json())
		expect(text).toContain('approve')
		expect(text).toContain('decision')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await sendEvents(s.workspace.id, s.gmail.id)).toHaveLength(0)
	})

	it('still cannot send when nobody has answered the card', async () => {
		const s = await setup({ agentAccess: 'read_write' })
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
		await reanswer(s, card.id)
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

describe('gmail_send_email: input', () => {
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

/**
 * A card that carries several emails in `decision.drafts`, each approved with its own Send.
 * The person's tap on a message is a reply `Send: <label> to <to> (<id>)`, the same words
 * the web and iPhone cards post.
 */
interface StackMessage {
	id: string
	to: string
	text: string
}

const ADA: StackMessage = {
	id: 'ada',
	to: 'Ada Lovelace <ada@example.com>',
	text: 'Subject: For Ada\n\nHi Ada, it has been a while.',
}
const BOB: StackMessage = {
	id: 'bob',
	to: 'Bob Byte <bob@example.com>',
	text: 'Subject: For Bob\n\nHi Bob, a quick note.',
}

const tap = (m: StackMessage, action: 'Send' | 'Skip' = 'Send') =>
	`${action}: Email to ${m.to} (${m.id})`

async function insertStackCard(
	s: Setup,
	messages: StackMessage[],
	replies: Array<{ by?: 'human' | 'agent'; content: string }> = [],
) {
	const anchor = await insertObject(db, s.workspace.id, s.human, { type: 'task' })
	const objectsById = new Map<string, { id: string }>()
	for (const m of messages) {
		const o = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: m.text,
		})
		objectsById.set(m.id, o)
	}
	const decision = {
		title: 'Send these two emails',
		summary: 'Two contacts have not heard from us in 14 days.',
		ask: 'I will not send these to customers alone.',
		options: [
			{
				label: 'Send all',
				consequences: ['Goes out now', 'Cannot be recalled'],
				destructive: true,
				recommended: true,
			},
			{ label: 'Hold', consequences: ['Nothing goes out', 'Contacts keep waiting'] },
		],
		drafts: messages.map((m) => ({
			id: m.id,
			object_id: objectsById.get(m.id)?.id,
			label: 'Email',
			to: m.to,
		})),
	}
	const [card] = await db
		.insert(events)
		.values({
			workspaceId: s.workspace.id,
			actorId: s.agent.id,
			action: 'commented',
			entityType: 'object',
			entityId: anchor.id,
			data: { content: 'Please approve.', mentions: [s.human], decision },
		})
		.returning()
	if (!card) throw new Error('card was not inserted')
	for (const r of replies) {
		await db.insert(events).values({
			workspaceId: s.workspace.id,
			actorId: r.by === 'agent' ? s.agent.id : s.human,
			action: 'commented',
			entityType: 'object',
			entityId: anchor.id,
			data: {
				content: r.content,
				parentEventId: card.id,
				...(r.by === 'agent'
					? {}
					: { approved_send_hash: await approvedHash(s, card.id, r.content) }),
			},
		})
	}
	return { card, objectsById }
}

describe('gmail_send_email: a card with several emails', () => {
	it('sends the message the person approved, exactly as the card shows it', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA, BOB], [{ content: tap(ADA) }])
		fetchMock.mockResolvedValueOnce(gmailOk('m-ada'))

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ mode: 'approved_draft', message_id: 'm-ada' })
		const mime = sentMime()
		expect(mime).toContain('ada@example.com')
		expect(mime).toContain('Subject: For Ada')
		expect(mime).toContain(Buffer.from('Hi Ada, it has been a while.').toString('base64'))
		expect(mime).not.toContain('bob@example.com')
		const rows = await sendEvents(s.workspace.id, s.gmail.id)
		expect(
			rows.some((e) => (e.data as { approval_draft_id?: string }).approval_draft_id === 'ada'),
		).toBe(true)
	})

	it('does not send a message the person has not answered, even when another was approved', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA, BOB], [{ content: tap(ADA) }])

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'bob',
		})

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('No person has answered that message')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a message the person skipped', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA], [{ content: tap(ADA, 'Skip') }])

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('skipped')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('counts the latest answer for that message: Send then Skip is a Skip', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(
			s,
			[ADA],
			[{ content: tap(ADA) }, { content: tap(ADA, 'Skip') }],
		)

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('is not moved by what the person did with another message', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(
			s,
			[ADA, BOB],
			[{ content: tap(ADA) }, { content: tap(BOB, 'Skip') }],
		)
		fetchMock.mockResolvedValueOnce(gmailOk())

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(200)
	})

	it('never counts an agent saying "Send" for a message', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA], [{ by: 'agent', content: tap(ADA) }])

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not treat the card-level send option as approval for a message', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA, BOB], [{ content: 'Send all' }])

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('sends each message once, and each is claimed on its own', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(
			s,
			[ADA, BOB],
			[{ content: tap(ADA) }, { content: tap(BOB) }],
		)
		fetchMock.mockResolvedValueOnce(gmailOk('m1')).mockResolvedValueOnce(gmailOk('m2'))

		const ada = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})
		const bob = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'bob',
		})
		const adaAgain = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect([ada.status, bob.status]).toEqual([200, 200])
		expect(adaAgain.status).toBe(409)
		expect(JSON.stringify(await adaAgain.json())).toContain('already used')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('refuses one message whose text changed after approval and still sends the other', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card, objectsById } = await insertStackCard(
			s,
			[ADA, BOB],
			[{ content: tap(ADA) }, { content: tap(BOB) }],
		)
		await db
			.update(objects)
			.set({
				content: 'Subject: Changed\n\nNot what was approved',
				updatedAt: new Date(Date.now() + 5000),
			})
			.where(eq(objects.id, objectsById.get('ada')?.id as string))
		fetchMock.mockResolvedValueOnce(gmailOk())

		const ada = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})
		const bob = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'bob',
		})

		expect(ada.status).toBe(409)
		expect(JSON.stringify(await ada.json())).toContain('changed after the person approved')
		expect(bob.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('asks which message when draft_id is missing, and names the ids', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA, BOB], [{ content: tap(ADA) }])

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		const text = JSON.stringify(await res.json())
		expect(text).toContain('draft_id')
		expect(text).toContain('ada, bob')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft_id the card does not have', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertStackCard(s, [ADA], [{ content: tap(ADA) }])

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'nobody',
		})

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a draft_id on a card that carries a single draft', async () => {
		const s = await setup({ agentAccess: 'read_write' })
		const { card } = await insertApprovalCard(s)

		const res = await post(s.agent.id, s.workspace.id, {
			approval_comment_id: card.id,
			draft_id: 'ada',
		})

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a draft_id without an approval_comment_id', async () => {
		const s = await setup()

		const res = await post(s.agent.id, s.workspace.id, { ...DIRECT, draft_id: 'ada' })

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('gmail_send_email: an approval covers the exact text the person saw', () => {
	const TEXT_B = 'Subject: Something else\n\nText B, never shown to the person'

	it('refuses text B swapped in for approved text A when nothing logged the change', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		// No event and an old updatedAt: the edit-after-tap check has nothing to see.
		await db
			.update(objects)
			.set({ content: TEXT_B, updatedAt: new Date(Date.now() - 60_000) })
			.where(eq(objects.id, draftObject?.id as string))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(JSON.stringify(await res.json())).toContain('changed after the person approved')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await gmailActions(s.workspace.id, s.gmail.id)).toEqual([])
	})

	it('refuses when the draft object is cleared and the card holds other text', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		// The card also carries a stored body; with the object empty the send would fall back to it.
		const data = card.data as { decision: { draft: Record<string, unknown> } }
		const draft = { ...data.decision.draft, body: TEXT_B }
		await db
			.update(events)
			.set({ data: { ...data, decision: { ...data.decision, draft } } })
			.where(eq(events.id, card.id))
		await db
			.update(objects)
			.set({ content: '', updatedAt: new Date(Date.now() - 60_000) })
			.where(eq(objects.id, draftObject?.id as string))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await gmailActions(s.workspace.id, s.gmail.id)).toEqual([])
	})

	it('refuses when the draft object is cleared and nothing else is left to send', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db
			.update(objects)
			.set({ content: '', updatedAt: new Date(Date.now() - 60_000) })
			.where(eq(objects.id, draftObject?.id as string))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBeGreaterThanOrEqual(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an answer that recorded nothing about what the person saw', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		await db
			.update(events)
			.set({ data: sql`${events.data} - 'approved_send_hash'` })
			.where(sql`${events.data}->>'parentEventId' = ${String(card.id)}`)

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(409)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('still sends the unchanged approved text', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		fetchMock.mockResolvedValueOnce(gmailOk('sent-a'))

		const res = await post(s.agent.id, s.workspace.id, { approval_comment_id: card.id })

		expect(res.status).toBe(200)
		expect(sentMime()).toContain('Subject: Approved subject')
	})
})
