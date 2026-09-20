import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceMembers } from '@maskin/db/schema'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db } from './global-setup'

const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

// End-to-end coverage for GET /api/subscriptions/unread after the subscribe
// feature was retired. The route derives its rows from `events` + `read_state`
// rather than the `subscriptions` table, and two predicates decide what lands
// in the feed:
//   1. Comments that @-mention the calling actor.
//   2. Comments on `onboarding_session` objects when the caller is a workspace
//      owner (workspace_members.role = 'owner') of that workspace.
describe('GET /api/subscriptions/unread — events-derived surface', () => {
	function makeApp(actorId: string) {
		const app = new OpenAPIHono<Env>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', actorId)
			c.set('actorType', 'human')
			await next()
		})
		app.route('/api/subscriptions', subscriptionsRoutes)
		return app
	}

	function insertCommentEvent(input: {
		workspaceId: string
		entityId: string
		actorId: string
		mentions?: string[]
		content?: string
	}) {
		return db.insert(events).values({
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			action: 'commented',
			entityType: 'object',
			entityId: input.entityId,
			data: {
				content: input.content ?? 'hello',
				mentions: input.mentions ?? [],
			},
		})
	}

	it('surfaces onboarding_session comments to the workspace owner without a mention', async () => {
		const owner = await insertActor(db, { name: 'Owner', email: `${randomUUID()}@t.local` })
		const workspace = await insertWorkspace(db, owner.id)
		const coach = await insertActor(db, { name: 'Coach', type: 'agent' })
		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: coach.id,
			role: 'member',
		})
		const session = await insertObject(db, workspace.id, coach.id, {
			type: 'onboarding_session',
			title: 'Onboarding',
		})
		await insertCommentEvent({
			workspaceId: workspace.id,
			entityId: session.id,
			actorId: coach.id,
			content: 'Coach prompt — no mention',
		})

		const app = makeApp(owner.id)
		const res = await app.request(
			jsonGet('/api/subscriptions/unread', { 'x-workspace-id': workspace.id }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { items: Array<{ entity_id: string }> }
		expect(body.items.map((i) => i.entity_id)).toContain(session.id)
	})

	it('hides onboarding_session comments from a non-owner in the same workspace', async () => {
		const owner = await insertActor(db, { name: 'Owner', email: `${randomUUID()}@t.local` })
		const workspace = await insertWorkspace(db, owner.id)
		const member = await insertActor(db, { name: 'Member', email: `${randomUUID()}@t.local` })
		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: member.id,
			role: 'member',
		})
		const coach = await insertActor(db, { name: 'Coach', type: 'agent' })
		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: coach.id,
			role: 'member',
		})
		const session = await insertObject(db, workspace.id, coach.id, {
			type: 'onboarding_session',
			title: 'Onboarding',
		})
		await insertCommentEvent({
			workspaceId: workspace.id,
			entityId: session.id,
			actorId: coach.id,
			content: 'Coach prompt for the owner only',
		})

		const app = makeApp(member.id)
		const res = await app.request(
			jsonGet('/api/subscriptions/unread', { 'x-workspace-id': workspace.id }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { items: Array<{ entity_id: string }> }
		expect(body.items.map((i) => i.entity_id)).not.toContain(session.id)
	})

	it('surfaces @-mentioned comments on any object type to the mentioned actor', async () => {
		const owner = await insertActor(db, { name: 'Owner', email: `${randomUUID()}@t.local` })
		const workspace = await insertWorkspace(db, owner.id)
		const other = await insertActor(db, { name: 'Other', email: `${randomUUID()}@t.local` })
		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: other.id,
			role: 'member',
		})
		const bet = await insertObject(db, workspace.id, owner.id, { type: 'bet' })
		await insertCommentEvent({
			workspaceId: workspace.id,
			entityId: bet.id,
			actorId: other.id,
			mentions: [owner.id],
			content: 'Hey @Owner',
		})

		const app = makeApp(owner.id)
		const res = await app.request(
			jsonGet('/api/subscriptions/unread', { 'x-workspace-id': workspace.id }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			items: Array<{ entity_id: string; mentioning_unread_count: number }>
		}
		const row = body.items.find((i) => i.entity_id === bet.id)
		expect(row).toBeDefined()
		expect(row?.mentioning_unread_count).toBe(1)
	})

	it('does not surface an unmentioned comment on a non-onboarding object', async () => {
		const owner = await insertActor(db, { name: 'Owner', email: `${randomUUID()}@t.local` })
		const workspace = await insertWorkspace(db, owner.id)
		const other = await insertActor(db, { name: 'Other', email: `${randomUUID()}@t.local` })
		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: other.id,
			role: 'member',
		})
		const bet = await insertObject(db, workspace.id, owner.id, { type: 'bet' })
		await insertCommentEvent({
			workspaceId: workspace.id,
			entityId: bet.id,
			actorId: other.id,
			content: 'no mention here',
		})

		const app = makeApp(owner.id)
		const res = await app.request(
			jsonGet('/api/subscriptions/unread', { 'x-workspace-id': workspace.id }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { items: Array<{ entity_id: string }> }
		expect(body.items.map((i) => i.entity_id)).not.toContain(bet.id)
	})
})
