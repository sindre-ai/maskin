import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: approvalRoutes } = await import('../../routes/object-approvals')
const { default: objectRoutes } = await import('../../routes/objects')

/**
 * Drafts that are not emails: a LinkedIn message, a LinkedIn post (including the shape the
 * Copywriter files, with no `metadata.kind`), a Slack message. Real Postgres, because what
 * is being proved is database behaviour: the newest human `approved` event decides whether a
 * draft is approved, it is bound to a hash of what would go out, and any change to that
 * (the text, the recipient, the account a post is published as) withdraws it.
 */

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
			on: () => undefined,
			off: () => undefined,
			createSession: vi.fn(),
		} as never)
		await next()
	})
	app.route('/api/objects', approvalRoutes as never)
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
	return { human, workspace, agent }
}

type Preview = {
	kind: string
	label: string
	body: string
	content_hash: string
	missing: string[]
	details: Array<{ label: string; value: string }>
	delivery?: { state: string }
}

async function previewOf(actorId: string, workspaceId: string, objectId: string) {
	const res = await appFor(actorId).request(`/api/objects/${objectId}`, {
		headers: { 'X-Workspace-Id': workspaceId },
	})
	expect(res.status).toBe(200)
	return ((await res.json()) as { preview: Preview | null }).preview
}

const approve = (actorId: string, workspaceId: string, objectId: string, hash?: string) =>
	appFor(actorId).request(`/api/objects/${objectId}/approval`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(hash ? { content_hash: hash } : {}),
	})

const POST = [
	'Account: sebk_personal',
	'Voice: sebastian-voice',
	'',
	'--- POST ---',
	'Most agent demos fail on the handoff.',
	'',
	'--- MEDIA ---',
	'none',
].join('\n')

describe('LinkedIn message drafts', () => {
	it('reads as a draft with a preview before anyone approves it', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hej Merethe, tak for forbindelsen.',
			metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
		})
		expect(await previewOf(s.human, s.workspace.id, draft.id)).toMatchObject({
			kind: 'linkedin_message',
			label: 'LinkedIn message',
			missing: [],
			delivery: { state: 'draft' },
		})
	})

	it('is approved by a person, and editing the text withdraws the approval', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hej Merethe, tak for forbindelsen.',
			metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
		})
		const shown = await previewOf(s.human, s.workspace.id, draft.id)
		const res = await approve(s.human, s.workspace.id, draft.id, shown?.content_hash)
		expect(res.status).toBe(200)
		expect((await previewOf(s.human, s.workspace.id, draft.id))?.delivery?.state).toBe('approved')

		await db
			.update(objects)
			.set({ content: 'Hej Merethe, kort besked.' })
			.where(eq(objects.id, draft.id))
		expect((await previewOf(s.human, s.workspace.id, draft.id))?.delivery?.state).toBe('draft')
	})

	it('refuses an agent that tries to approve its own message', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hej',
			metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
		})
		expect((await approve(s.agent.id, s.workspace.id, draft.id)).status).toBe(403)
		const rows = await db.select().from(events).where(eq(events.action, 'approved'))
		expect(rows.filter((r) => r.entityId === draft.id)).toHaveLength(0)
	})

	it('approves a reply with no recipient, and the card warns that nobody is named', async () => {
		// A reply goes into a conversation the agent already holds, so the recipient is
		// recommended, not required (see the linkedin_message deliverable in config.ts).
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hej',
			metadata: { kind: 'linkedin_message' },
		})
		const shown = (await previewOf(s.human, s.workspace.id, draft.id)) as Preview & {
			warnings: string[]
		}
		expect(shown.missing).toEqual([])
		expect(shown.warnings).toContain('To is not filed.')
		const res = await approve(s.human, s.workspace.id, draft.id)
		expect(res.status).toBe(200)
	})

	it('refuses to approve a connection request that has no recipient', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'Hej',
			metadata: { kind: 'linkedin_connection_request' },
		})
		const res = await approve(s.human, s.workspace.id, draft.id)
		expect(res.status).toBe(400)
	})
})

describe('LinkedIn post drafts', () => {
	it("previews a post filed the Copywriter's way, with no kind, as only the post", async () => {
		const s = await setup()
		const post = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'content',
			content: POST,
			metadata: { content_type: 'linkedin_post', scheduled_date: '2026-10-27' },
		})
		expect(await previewOf(s.human, s.workspace.id, post.id)).toMatchObject({
			kind: 'linkedin_post',
			label: 'LinkedIn post',
			body: 'Most agent demos fail on the handoff.',
			details: [{ label: 'Scheduled', value: '2026-10-27' }],
			missing: [],
		})
	})

	it('withdraws the approval when the account it is published as changes', async () => {
		const s = await setup()
		const post = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'A post.',
			metadata: { kind: 'linkedin_post', account: 'sebk_personal' },
		})
		const shown = await previewOf(s.human, s.workspace.id, post.id)
		expect((await approve(s.human, s.workspace.id, post.id, shown?.content_hash)).status).toBe(200)
		expect((await previewOf(s.human, s.workspace.id, post.id))?.delivery?.state).toBe('approved')

		await db
			.update(objects)
			.set({ metadata: { kind: 'linkedin_post', account: 'maskin_page' } })
			.where(eq(objects.id, post.id))
		expect((await previewOf(s.human, s.workspace.id, post.id))?.delivery?.state).toBe('draft')
	})

	it('does not approve a post whose post block is empty', async () => {
		const s = await setup()
		const post = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'content',
			content: 'Account: x\n--- POST ---\n--- MEDIA ---\nnone',
			metadata: { content_type: 'linkedin_post' },
		})
		expect((await approve(s.human, s.workspace.id, post.id)).status).toBe(400)
	})
})

describe('Slack message drafts', () => {
	it('previews the channel and is approved by a person', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'The fix is live.',
			metadata: { kind: 'slack_message', channel: '#coach-maskin' },
		})
		const shown = await previewOf(s.human, s.workspace.id, draft.id)
		expect(shown).toMatchObject({
			kind: 'slack_message',
			details: [{ label: 'Channel', value: '#coach-maskin' }],
		})
		expect((await approve(s.human, s.workspace.id, draft.id, shown?.content_hash)).status).toBe(200)
	})

	it('needs a channel before it can be approved', async () => {
		const s = await setup()
		const draft = await insertObject(db, s.workspace.id, s.agent.id, {
			type: 'task',
			content: 'The fix is live.',
			metadata: { kind: 'slack_message' },
		})
		expect((await approve(s.human, s.workspace.id, draft.id)).status).toBe(400)
	})
})
