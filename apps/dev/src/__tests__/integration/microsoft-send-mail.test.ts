import { events, integrations, objects, workspaceMembers } from '@maskin/db/schema'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { approvedSendHashFor } from '../../lib/integrations/providers/gmail/approval-hash'
import { createMicrosoftMcpServer } from '../../lib/integrations/providers/microsoft/mcp-server'
import { toolGateFor } from '../../lib/integrations/tool-gate'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import {
	insertActor,
	insertAgentGrant,
	insertObject,
	insertSendMode,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * outlook_send_mail against real Postgres. Graph is stubbed at fetch: this file proves our rules
 * (who may send, that a person approved exactly this text, once, never retried), not that Graph
 * behaves as assumed, which needs a live work account. The approval itself is the one Gmail
 * uses, so the card and object shapes below are the same as in gmail-send-email.test.ts.
 */

const TOKEN = 'eyJ.live-graph-token'
const SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail'
const EMAIL_TEXT = 'Subject: Approved subject\n\nApproved text, edited by the person'

const accepted = () => new Response(null, { status: 202 })
const graphError = (status: number, code = 'ErrorX') =>
	new Response(JSON.stringify({ error: { code, message: 'secret detail from Graph' } }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(
	opts: {
		access?: 'read' | 'read_write'
		sendMode?: 'always_allow' | 'ask_first' | 'deny'
	} = {},
) {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	await insertSendMode(db, {
		workspaceId: workspace.id,
		agentId: agent.id,
		kind: 'email',
		mode: opts.sendMode ?? 'ask_first',
	})
	const [microsoft] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'microsoft',
			status: 'active',
			externalId: 'sender@example.com',
			credentials: encrypt(
				JSON.stringify({ accessToken: 'unused', expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: human,
		})
		.returning()
	if (!microsoft) throw new Error('microsoft integration was not inserted')
	await insertAgentGrant(db, {
		workspaceId: workspace.id,
		integrationId: microsoft.id,
		actorId: agent.id,
		access: opts.access ?? 'read_write',
	})
	return { human, workspace, agent, microsoft }
}

/** The Outlook MCP server as an agent session sees it: real gate, real database, stubbed Graph. */
async function connect(s: Setup, fetchImpl: ReturnType<typeof vi.fn>) {
	const trackToolCalled = vi.fn(async () => undefined)
	const gate = await toolGateFor(db, {
		workspaceId: s.workspace.id,
		actorId: s.agent.id,
		integrationId: s.microsoft.id,
		provider: 'microsoft',
		providerLabel: 'Microsoft',
	})
	const server = createMicrosoftMcpServer(
		{
			db,
			workspaceId: s.workspace.id,
			actorId: s.agent.id,
			sessionId: 'sess-1',
			integrationId: s.microsoft.id,
			getAccessToken: async () => TOKEN,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			trackToolCalled,
		},
		gate,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	const send = async (args: Record<string, unknown>) => {
		const res = await client.callTool({ name: 'outlook_send_mail', arguments: args })
		const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
		return {
			res,
			text,
			body: JSON.parse(text) as { sent?: boolean; error: { code: string; message: string } },
		}
	}
	return { send, trackToolCalled }
}

/** The For You card an agent posts, and the person's tap on it. Same shape as the Gmail tests. */
async function insertApprovalCard(
	s: Setup,
	opts: { answers?: Array<{ by: 'human' | 'agent'; content: string }> } = {},
) {
	const anchor = await insertObject(db, s.workspace.id, s.human, { type: 'task' })
	const draftObject = await insertObject(db, s.workspace.id, s.agent.id, {
		type: 'task',
		content: EMAIL_TEXT,
	})
	const decision = {
		title: 'Send the intro email',
		summary: 'Ada has not heard from us in 14 days.',
		ask: 'I will not send this to a customer alone.',
		options: [
			{
				label: 'Send it',
				consequences: ['Goes out now', 'Cannot be recalled'],
				destructive: true,
				recommended: true,
			},
			{ label: 'Hold', consequences: ['Nothing goes out'] },
		],
		draft: {
			object_id: draftObject.id,
			label: 'Email to Ada',
			to: 'Ada Lovelace <ada@example.com>',
		},
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
	for (const a of opts.answers ?? [{ by: 'human', content: 'Send it' }]) {
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
					? {
							approved_send_hash: await approvedSendHashFor(db, s.workspace.id, card.id, a.content),
						}
					: {}),
			},
		})
	}
	return { card, draftObject }
}

async function insertEmailObject(s: Setup) {
	return insertObject(db, s.workspace.id, s.human, {
		type: 'task',
		status: 'todo',
		content: 'Hi Ada, short note.',
		metadata: { kind: 'email', to: 'ada@example.com', subject: 'Intro' },
	})
}

async function approveObject(s: Setup, object: typeof objects.$inferSelect) {
	const preview = buildObjectPreview(object)
	if (!preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: s.workspace.id,
		actorId: s.human,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

const integrationActions = async (s: Setup) =>
	(
		await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, s.workspace.id),
					eq(events.entityId, s.microsoft.id),
					eq(events.entityType, 'integration'),
				),
			)
	)
		.map((e) => e.data as { gmail_action?: string; provider?: string })
		.filter((d) => d.gmail_action)

afterEach(() => {
	vi.restoreAllMocks()
})

describe('outlook_send_mail: sends only what a person approved', () => {
	it('sends the email on a card a person answered, once, with the approved text', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const { res, body } = await send({ approval_comment_id: card.id })

		expect(res.isError).toBeFalsy()
		expect(body.sent).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(SEND_URL)
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		expect(JSON.parse(init.body as string)).toEqual({
			message: {
				subject: 'Approved subject',
				body: { contentType: 'text', content: 'Approved text, edited by the person' },
				toRecipients: [{ emailAddress: { address: 'ada@example.com', name: 'Ada Lovelace' } }],
				ccRecipients: [],
			},
			saveToSentItems: true,
		})
		// The claim, then the send, both tagged to Microsoft.
		expect(await integrationActions(s)).toEqual([
			expect.objectContaining({ gmail_action: 'send_claim', provider: 'microsoft' }),
			expect.objectContaining({ gmail_action: 'sent', provider: 'microsoft' }),
		])
	})

	it('refuses a second use of the same approval and does not call Graph again', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		expect((await send({ approval_comment_id: card.id })).res.isError).toBeFalsy()
		const again = await send({ approval_comment_id: card.id })

		expect(again.res.isError).toBe(true)
		expect(again.text).toContain('already used')
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('refuses when the draft changed after the person answered', async () => {
		const s = await setup()
		const { card, draftObject } = await insertApprovalCard(s)
		await db
			.update(objects)
			.set({ content: 'Subject: Approved subject\n\nA different text', updatedAt: new Date() })
			.where(eq(objects.id, draftObject.id))
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const { res, text } = await send({ approval_comment_id: card.id })

		expect(res.isError).toBe(true)
		expect(text).toContain('changed after the person approved')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses a card nobody answered, and a reply written by an agent', async () => {
		const s = await setup()
		const none = await insertApprovalCard(s, { answers: [] })
		const byAgent = await insertApprovalCard(s, { answers: [{ by: 'agent', content: 'Send it' }] })
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		for (const card of [none.card, byAgent.card]) {
			const { res, text } = await send({ approval_comment_id: card.id })
			expect(res.isError).toBe(true)
			expect(text).toContain('No person has answered')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('sends an email object a person approved, ends its task, and refuses it a second time', async () => {
		const s = await setup()
		const object = await insertEmailObject(s)
		await approveObject(s, object)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const first = await send({ object_id: object.id })
		const second = await send({ object_id: object.id })

		expect(first.res.isError).toBeFalsy()
		expect(second.res.isError).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const delivered = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, object.id), eq(events.action, 'delivered')))
		expect(delivered).toHaveLength(1)
		expect(delivered[0]?.data).toMatchObject({ provider: 'microsoft' })
		const [after] = await db.select().from(objects).where(eq(objects.id, object.id))
		expect(after?.status).toBe('done')
	})

	it('refuses an email object nobody approved, and one edited after its approval', async () => {
		const s = await setup()
		const unapproved = await insertEmailObject(s)
		const edited = await insertEmailObject(s)
		await approveObject(s, edited)
		await db
			.update(objects)
			.set({ content: 'Not what was approved' })
			.where(eq(objects.id, edited.id))
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		for (const o of [unapproved, edited]) {
			const { res, text } = await send({ object_id: o.id })
			expect(res.isError).toBe(true)
			expect(text).toContain('A person has to approve')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('outlook_send_mail: who may send', () => {
	it('refuses a Read agent, even with an approval, and never reaches Graph', async () => {
		const s = await setup({ access: 'read' })
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const { res, text } = await send({ approval_comment_id: card.id })

		expect(res.isError).toBe(true)
		expect(text).toContain('Access denied')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(await integrationActions(s)).toEqual([])
	})

	it('holds an agent set to Always allow to the same approval', async () => {
		const s = await setup({ sendMode: 'always_allow' })
		const object = await insertEmailObject(s)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const { res } = await send({ object_id: object.id })

		expect(res.isError).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses an approved email when the send setting is deny', async () => {
		const s = await setup({ sendMode: 'deny' })
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockResolvedValue(accepted())
		const { send } = await connect(s, fetchImpl)

		const { res, text } = await send({ approval_comment_id: card.id })

		expect(res.isError).toBe(true)
		expect(text).toContain('turned off')
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('outlook_send_mail: never retried', () => {
	it('does not retry a gateway error, and keeps the approval locked as unclear', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockResolvedValue(graphError(502, 'BadGateway'))
		const { send } = await connect(s, fetchImpl)

		const first = await send({ approval_comment_id: card.id })
		const second = await send({ approval_comment_id: card.id })

		expect(first.body.error.code).toBe('UNKNOWN_OUTCOME')
		expect(first.text).toContain('Sent Items')
		expect(second.res.isError).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect((await integrationActions(s)).map((a) => a.gmail_action)).toEqual([
			'send_claim',
			'send_unknown',
		])
	})

	it('treats a dropped connection as unclear, not as a refusal', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
		const { send } = await connect(s, fetchImpl)

		const first = await send({ approval_comment_id: card.id })
		const second = await send({ approval_comment_id: card.id })

		expect(first.body.error.code).toBe('UNKNOWN_OUTCOME')
		expect(second.res.isError).toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('releases the approval when Graph refuses it, so the same approval can be used again', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(graphError(403, 'ErrorAccessDenied'))
			.mockResolvedValueOnce(accepted())
		const { send } = await connect(s, fetchImpl)

		const first = await send({ approval_comment_id: card.id })
		expect(first.body.error.code).toBe('NOT_ALLOWED')
		expect(first.text).not.toContain('secret detail')

		const second = await send({ approval_comment_id: card.id })
		expect(second.res.isError).toBeFalsy()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})
})

describe('outlook_send_mail: tracking', () => {
	it('fires integration_tool_called with provider microsoft, ids and outcome only', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s)
		const { send, trackToolCalled } = await connect(s, vi.fn().mockResolvedValue(accepted()))

		await send({ approval_comment_id: card.id })

		expect(trackToolCalled).toHaveBeenCalledTimes(1)
		expect(trackToolCalled).toHaveBeenCalledWith({
			provider: 'microsoft',
			tool: 'outlook_send_mail',
			outcome: 'success',
			errorCode: null,
			actorId: s.agent.id,
			sessionId: 'sess-1',
			workspaceId: s.workspace.id,
		})
	})

	it('reports a refused send as outcome error with the code', async () => {
		const s = await setup()
		const { card } = await insertApprovalCard(s, { answers: [] })
		const { send, trackToolCalled } = await connect(s, vi.fn())

		await send({ approval_comment_id: card.id })

		expect(trackToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: 'microsoft',
				tool: 'outlook_send_mail',
				outcome: 'error',
				errorCode: 'NOT_SENT',
			}),
		)
	})
})
