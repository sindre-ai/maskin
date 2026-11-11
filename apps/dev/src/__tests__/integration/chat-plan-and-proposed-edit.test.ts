import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, conversationParticipants, workspaceMembers } from '@maskin/db/schema'
import { proposedEditToUpdate } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { insertActor, insertConversation, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')
const { default: objectRoutes } = await import('../../routes/objects')

/**
 * A plan and a proposed edit ride on an agent's message as versioned blocks. Real Postgres:
 * the claims are about what the message read returns and what the table holds after Apply.
 */

function appFor(actorId: string, actorType: 'human' | 'agent') {
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	const app = new OpenAPIHono<{
		Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes as never)
	app.route('/api/objects', objectRoutes as never)
	return app
}

async function setup() {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const conversation = await insertConversation(db, workspace.id, human)
	if (!conversation) throw new Error('conversation was not inserted')
	await db.insert(conversationParticipants).values([
		{ conversationId: conversation.id, actorId: human },
		{ conversationId: conversation.id, actorId: agent.id },
	])
	const loop = await insertObject(db, workspace.id, human, {
		type: 'task',
		title: 'Weekly digest',
		status: 'todo',
		metadata: { cadence: 'weekly' },
	})
	if (!loop) throw new Error('object was not inserted')
	return { human, agent, workspace, conversation, loop }
}

type Setup = Awaited<ReturnType<typeof setup>>
type ReadMessage = { content: string; metadata: Record<string, unknown> | null } & Record<
	string,
	unknown
>

const headers = (s: Setup) => ({
	'Content-Type': 'application/json',
	'X-Workspace-Id': s.workspace.id,
})

const postMessage = (
	s: Setup,
	as: 'human' | 'agent',
	content: string,
	metadata: Record<string, unknown>,
) =>
	appFor(as === 'agent' ? s.agent.id : s.human, as).request(
		`/api/conversations/${s.conversation.id}/messages`,
		{ method: 'POST', headers: headers(s), body: JSON.stringify({ content, metadata }) },
	)

async function readMessages(s: Setup): Promise<ReadMessage[]> {
	const res = await appFor(s.human, 'human').request(
		`/api/conversations/${s.conversation.id}/messages`,
		{ headers: headers(s) },
	)
	return ((await res.json()) as { messages: ReadMessage[] }).messages
}

const plan = {
	version: 1,
	steps: [{ title: 'Pull last week', status: 'done' }, { title: 'Draft the digest' }],
}
const edit = (s: Setup) => ({
	version: 1,
	object_id: s.loop.id,
	field: 'metadata.cadence',
	before: 'weekly',
	after: 'daily',
})

describe('chat plan and proposed edit', () => {
	it('returns an agent plan and proposed edit as typed fields on the read', async () => {
		const s = await setup()
		const res = await postMessage(s, 'agent', 'Plan: pull last week, draft the digest', {
			plan,
			proposed_edit: edit(s),
		})
		expect(res.status).toBe(201)
		const posted = (await res.json()) as ReadMessage
		expect(posted.plan).toEqual(plan)

		const read = (await readMessages(s)).find((m) => m.content.startsWith('Plan:'))
		expect(read?.plan).toEqual(plan)
		expect(read?.proposed_edit).toEqual(edit(s))
		expect(read?.content).toBe('Plan: pull last week, draft the digest')
	})

	it('returns neither field on a message without them', async () => {
		const s = await setup()
		await postMessage(s, 'agent', 'Just a note', {})
		const read = (await readMessages(s)).find((m) => m.content === 'Just a note')
		expect(read).toBeDefined()
		expect(read).not.toHaveProperty('plan')
		expect(read).not.toHaveProperty('proposed_edit')
	})

	it('drops a plan or edit a person tries to post, so only agents can write them', async () => {
		const s = await setup()
		const res = await postMessage(s, 'human', 'Forged', { plan, proposed_edit: edit(s) })
		expect(res.status).toBe(201)
		const read = (await readMessages(s)).find((m) => m.content === 'Forged')
		expect(read).not.toHaveProperty('plan')
		expect(read).not.toHaveProperty('proposed_edit')
		expect(read?.metadata ?? {}).not.toHaveProperty('plan')
		expect(read?.metadata ?? {}).not.toHaveProperty('proposed_edit')
	})

	it('refuses a version the server does not know when an agent posts it', async () => {
		const s = await setup()
		const res = await postMessage(s, 'agent', 'Future', { plan: { ...plan, version: 2 } })
		expect(res.status).toBe(400)
	})

	it('applies a proposed edit once, through the normal object update and its event', async () => {
		const s = await setup()
		const proposed = edit(s)
		const update = proposedEditToUpdate(proposed as never)
		expect(update).toEqual({ metadata: { cadence: 'daily' } })

		const res = await appFor(s.human, 'human').request(`/api/objects/${s.loop.id}`, {
			method: 'PATCH',
			headers: headers(s),
			body: JSON.stringify(update),
		})
		expect(res.status).toBe(200)
		const changed = (await res.json()) as { metadata: Record<string, unknown>; title: string }
		expect(changed.metadata.cadence).toBe('daily')
		expect(changed.title).toBe('Weekly digest')

		const updates = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.loop.id), eq(events.action, 'updated')))
		expect(updates).toHaveLength(1)
	})
})
