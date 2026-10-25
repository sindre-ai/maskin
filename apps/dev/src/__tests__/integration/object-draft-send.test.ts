import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertActor, insertAgentGrant, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')
const { default: approvalRoutes } = await import('../../routes/object-approvals')
const { default: objectRoutes } = await import('../../routes/objects')
const { default: eventsRoutes } = await import('../../routes/events')

/**
 * An email held by an object (`metadata.kind = 'email'`), approved by a person and sent by
 * an agent. Real Postgres, because the approval is whatever the newest human-written
 * `approved` event on the object says, bound to a content hash, and a send is claimed once
 * per approval. Gmail itself is stubbed at `fetch`: this proves our rules, not Gmail.
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

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: {
			db: Database
			actorId: string
			actorType: string
			notifyBridge: unknown
			sessionManager: unknown
		}
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as never)
		c.set('sessionManager', {
			createSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
			on: () => undefined,
			off: () => undefined,
		} as never)
		await next()
	})
	app.route('/api/integrations/gmail', gmailRoutes as never)
	app.route('/api/objects', approvalRoutes as never)
	app.route('/api/objects', objectRoutes as never)
	app.route('/api/events', eventsRoutes as never)
	return app
}

const json = (workspaceId: string, body?: Record<string, unknown>) => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
	body: JSON.stringify(body ?? {}),
})

const sendDraft = (actorId: string, workspaceId: string, objectId: string) =>
	appFor(actorId).request(
		'/api/integrations/gmail/send',
		json(workspaceId, { object_id: objectId }),
	)

const approve = (actorId: string, workspaceId: string, objectId: string, hash?: string) =>
	appFor(actorId).request(
		`/api/objects/${objectId}/approval`,
		json(workspaceId, hash ? { content_hash: hash } : {}),
	)

const getObject = (actorId: string, workspaceId: string, objectId: string) =>
	appFor(actorId).request(`/api/objects/${objectId}`, {
		headers: { 'X-Workspace-Id': workspaceId },
	})

async function setup(access: 'read' | 'read_write' = 'read_write') {
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
	await insertAgentGrant(db, {
		workspaceId: workspace.id,
		integrationId: gmail.id,
		actorId: agent.id,
		access,
	})
	const draft = await insertObject(db, workspace.id, agent.id, {
		type: 'task',
		content: 'Hi Ada,\n\nThursday works.',
		metadata: { kind: 'email', to: 'Ada Lovelace <ada@example.com>', subject: 'Thursday' },
	})
	return { human, workspace, agent, gmail, draft }
}

type Preview = { content_hash: string; delivery?: { state: string } }
const previewOf = async (s: Awaited<ReturnType<typeof setup>>) =>
	((await (await getObject(s.human, s.workspace.id, s.draft.id)).json()) as { preview: Preview })
		.preview

describe('object email drafts', () => {
	it('reads as a draft with a preview before anyone approves it', async () => {
		const s = await setup()
		const preview = await previewOf(s)
		expect(preview).toMatchObject({
			kind: 'email',
			subject: 'Thursday',
			delivery: { state: 'draft' },
		})
	})

	it('refuses an agent that tries to approve its own draft', async () => {
		const s = await setup('read_write')
		const res = await approve(s.agent.id, s.workspace.id, s.draft.id)
		expect(res.status).toBe(403)
		const rows = await db.select().from(events).where(eq(events.action, 'approved'))
		expect(rows.filter((r) => r.entityId === s.draft.id)).toHaveLength(0)
	})

	it('refuses to approve a draft that is missing its recipient', async () => {
		const s = await setup()
		const bare = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hello',
			metadata: { kind: 'email', subject: 'Hi' },
		})
		const res = await approve(s.human, s.workspace.id, bare.id)
		expect(res.status).toBe(400)
		expect(
			((await res.json()) as { message?: string; error?: { message?: string } }).error?.message ??
				'',
		).toContain('To')
	})

	it('refuses an approval of a draft that changed after it was shown', async () => {
		const s = await setup()
		const shown = await previewOf(s)
		await db.execute(
			`update objects set content = 'Changed under you' where id = '${s.draft.id}'` as never,
		)
		const res = await approve(s.human, s.workspace.id, s.draft.id, shown.content_hash)
		expect(res.status).toBe(409)
	})

	it('does not send an unapproved draft, and sends it once a person approves it', async () => {
		const s = await setup('read_write')
		const refused = await sendDraft(s.agent.id, s.workspace.id, s.draft.id)
		expect(refused.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()

		const shown = await previewOf(s)
		expect((await approve(s.human, s.workspace.id, s.draft.id, shown.content_hash)).status).toBe(
			200,
		)
		expect((await previewOf(s)).delivery?.state).toBe('approved')

		fetchMock.mockResolvedValueOnce(gmailOk('m1'))
		const sent = await sendDraft(s.agent.id, s.workspace.id, s.draft.id)
		expect(sent.status).toBe(200)
		expect(await sent.json()).toMatchObject({ message_id: 'm1', mode: 'approved_draft' })
		expect((await previewOf(s)).delivery?.state).toBe('sent')

		const delivered = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.draft.id), eq(events.action, 'delivered')))
		expect(delivered).toHaveLength(1)
	})

	it('uses one approval for one send', async () => {
		const s = await setup('read_write')
		await approve(s.human, s.workspace.id, s.draft.id)
		fetchMock.mockResolvedValueOnce(gmailOk())
		expect((await sendDraft(s.agent.id, s.workspace.id, s.draft.id)).status).toBe(200)
		const again = await sendDraft(s.agent.id, s.workspace.id, s.draft.id)
		expect(again.status).toBe(409)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('withdraws the approval when the text is edited afterwards', async () => {
		const s = await setup('read_write')
		await approve(s.human, s.workspace.id, s.draft.id)
		await db.execute(
			`update objects set content = 'Hi Ada, how about Friday?' where id = '${s.draft.id}'` as never,
		)
		expect((await previewOf(s)).delivery?.state).toBe('draft')
		const res = await sendDraft(s.agent.id, s.workspace.id, s.draft.id)
		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses to send an object that is not an email draft', async () => {
		const s = await setup('read_write')
		const plain = await insertObject(db, s.workspace.id, s.agent.id, { type: 'task', content: 'x' })
		expect((await sendDraft(s.agent.id, s.workspace.id, plain.id)).status).toBe(400)
	})
})

describe('approving by answering a decision card', () => {
	const options = [
		{ label: 'Hold', consequences: ['Nothing is sent', 'Ada keeps waiting'] },
		{
			label: 'Send it',
			recommended: true,
			destructive: true,
			consequences: ['Goes out now', 'Cannot be recalled'],
		},
	]
	const decisionBase = {
		title: 'Send the intro email?',
		summary: 'Ada has not heard from us in 14 days.',
		ask: 'This goes to a customer in your name, so I will not send it alone.',
		options,
	}

	type S = Awaited<ReturnType<typeof setup>>

	async function postCard(s: S, decision: Record<string, unknown>) {
		const anchor = await insertObject(db, s.workspace.id, s.human, { type: 'task' })
		const res = await appFor(s.agent.id, 'agent').request('/api/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': s.workspace.id },
			body: JSON.stringify({
				entity_id: anchor.id,
				content: 'Please approve.',
				mentions: [s.human],
				decision,
			}),
		})
		expect(res.status).toBe(201)
		const card = (await res.json()) as { id: number }
		return { anchor, cardId: Number(card.id) }
	}

	const reply = (
		s: S,
		card: { anchor: { id: string }; cardId: number },
		content: string,
		opts: { as?: 'human' | 'agent'; source?: string } = {},
	) =>
		appFor(opts.as === 'agent' ? s.agent.id : s.human, opts.as ?? 'human').request('/api/events', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': s.workspace.id,
				...(opts.source ? { 'X-Client-Source': opts.source } : {}),
			},
			body: JSON.stringify({
				entity_id: card.anchor.id,
				content,
				parent_event_id: card.cardId,
			}),
		})

	const approvals = (objectId: string) =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, objectId), eq(events.action, 'approved')))

	it('approves the draft when the person chooses the send option, before the reply lands', async () => {
		const s = await setup('read_write')
		const card = await postCard(s, { ...decisionBase, draft: { object_id: s.draft.id } })

		const res = await reply(s, card, 'Send it')
		expect(res.status).toBe(201)
		const replyId = Number(((await res.json()) as { id: number }).id)

		const rows = await approvals(s.draft.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(s.human)
		expect(rows[0]?.data).toMatchObject({ via: 'reply', reply_to_event_id: card.cardId })
		// Written first, so the agent the reply wakes already finds it.
		expect(Number(rows[0]?.id)).toBeLessThan(replyId)
		expect((await previewOf(s)).delivery?.state).toBe('approved')

		fetchMock.mockResolvedValueOnce(gmailOk('m9'))
		expect((await sendDraft(s.agent.id, s.workspace.id, s.draft.id)).status).toBe(200)
	})

	it('does not approve when the person picks another option', async () => {
		const s = await setup('read_write')
		const card = await postCard(s, { ...decisionBase, draft: { object_id: s.draft.id } })
		expect((await reply(s, card, 'Hold')).status).toBe(201)
		expect(await approvals(s.draft.id)).toHaveLength(0)
	})

	it('does not approve for an agent, or for a reply that came through MCP', async () => {
		const s = await setup('read_write')
		const card = await postCard(s, { ...decisionBase, draft: { object_id: s.draft.id } })
		expect((await reply(s, card, 'Send it', { as: 'agent' })).status).toBe(201)
		expect((await reply(s, card, 'Send it', { source: 'mcp' })).status).toBe(201)
		expect(await approvals(s.draft.id)).toHaveLength(0)
		expect((await sendDraft(s.agent.id, s.workspace.id, s.draft.id)).status).toBe(403)
	})

	it('does not add a second approval when the Approve call already recorded one', async () => {
		const s = await setup('read_write')
		const card = await postCard(s, { ...decisionBase, draft: { object_id: s.draft.id } })
		const shown = await previewOf(s)
		await approve(s.human, s.workspace.id, s.draft.id, shown.content_hash)
		await reply(s, card, 'Send it')
		expect(await approvals(s.draft.id)).toHaveLength(1)
	})

	it('posts the reply but approves nothing for a draft that is not complete', async () => {
		const s = await setup('read_write')
		const bare = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hello',
			metadata: { kind: 'email', subject: 'Hi' },
		})
		const card = await postCard(s, { ...decisionBase, draft: { object_id: bare.id } })
		expect((await reply(s, card, 'Send it')).status).toBe(201)
		expect(await approvals(bare.id)).toHaveLength(0)
	})

	it('approves only the message of a stacked card the person sent', async () => {
		const s = await setup('read_write')
		const second = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hi Dan',
			metadata: { kind: 'email', to: 'dan@example.com', subject: 'Hello Dan' },
		})
		const card = await postCard(s, {
			...decisionBase,
			drafts: [
				{ id: 'ada', object_id: s.draft.id, label: 'Email', to: 'Ada' },
				{ id: 'dan', object_id: second.id, label: 'Email', to: 'Dan' },
			],
		})

		expect((await reply(s, card, 'Send: Email to Ada (ada)')).status).toBe(201)
		expect(await approvals(s.draft.id)).toHaveLength(1)
		expect(await approvals(second.id)).toHaveLength(0)

		expect((await reply(s, card, 'Skip: Email to Dan (dan)')).status).toBe(201)
		expect(await approvals(second.id)).toHaveLength(0)
	})
})
