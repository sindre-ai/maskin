import { OpenAPIHono } from '@hono/zod-openapi'
import { hashPassword } from '@maskin/auth'
import {
	events,
	actors,
	notifications,
	readState,
	subscriptions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: accountRoutes } = await import('../../routes/account')

// Deleting an account runs against real Postgres: what matters is that the person is erased while
// the records that reference them survive, in one transaction, and that the blockers hold.
describe('account deletion (integration)', () => {
	const PASSWORD = 'correct horse battery'
	let me: { id: string; apiKey: string }
	let app: OpenAPIHono

	function appFor(actorId: string, actorType = 'human') {
		const a = new OpenAPIHono()
		a.use('*', async (c, next) => {
			// biome-ignore lint/suspicious/noExplicitAny: minimal context for the route under test
			const ctx = c as any
			ctx.set('db', db)
			ctx.set('actorId', actorId)
			ctx.set('actorType', actorType)
			await next()
		})
		a.route('/api/account', accountRoutes)
		return a
	}

	beforeEach(async () => {
		const row = await insertActor(db, {
			type: 'human',
			email: `ada-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
			passwordHash: await hashPassword(PASSWORD),
		})
		me = { id: row.id, apiKey: row.apiKey }
		app = appFor(me.id)
	})

	const del = (password = PASSWORD, a = app) =>
		a.request(jsonRequest('POST', '/api/account/delete', { password }))

	it('erases the person but keeps what they made, attributed to a deleted user', async () => {
		const ws = await insertWorkspace(db, me.id)
		const obj = await insertObject(db, ws.id, me.id, {
			title: 'My bet',
			type: 'bet',
			status: 'active',
		})

		await db.insert(readState).values({
			workspaceId: ws.id,
			actorId: me.id,
			entityType: 'object',
			entityId: obj.id,
			lastReadEventId: 0,
		})
		await db.insert(subscriptions).values({
			workspaceId: ws.id,
			actorId: me.id,
			entityType: 'object',
			entityId: obj.id,
			source: 'manual',
		})

		const res = await del()
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })

		const [after] = await db.select().from(actors).where(eq(actors.id, me.id))
		expect(after?.name).toBe('Deleted user')
		expect(after?.email).toBeNull()
		expect(after?.passwordHash).toBeNull()
		expect(after?.apiKey).not.toBe(me.apiKey)
		expect(after?.apiKey.startsWith('deleted_')).toBe(true)
		expect((after?.metadata as { deleted_at?: string } | null)?.deleted_at).toBeTruthy()

		// Their work stays, still pointing at the (now anonymous) actor row.
		const [kept] = await db.select().from(objects).where(eq(objects.id, obj.id))
		expect(kept?.title).toBe('My bet')
		expect(kept?.createdBy).toBe(me.id)

		// Their access and personal state are gone.
		expect(
			await db.select().from(workspaceMembers).where(eq(workspaceMembers.actorId, me.id)),
		).toEqual([])
		expect(await db.select().from(readState).where(eq(readState.actorId, me.id))).toEqual([])
		expect(await db.select().from(subscriptions).where(eq(subscriptions.actorId, me.id))).toEqual(
			[],
		)
		expect(
			await db.select().from(notifications).where(eq(notifications.targetActorId, me.id)),
		).toEqual([])
	})

	it('records that the person left each workspace, for the audit trail', async () => {
		const ws = await insertWorkspace(db, me.id)
		await del()
		const rows = await db.select().from(events).where(eq(events.workspaceId, ws.id))
		const left = rows.find((e) => e.entityType === 'workspace_member' && e.action === 'deleted')
		expect(left).toBeDefined()
		expect(left?.data).toMatchObject({ account_deleted: true, self_removal: true })
	})

	it('frees the email and refuses a second deletion', async () => {
		const row = await db.select().from(actors).where(eq(actors.id, me.id))
		const email = row[0]?.email as string
		expect((await del()).status).toBe(200)
		// Nothing left to sign in with, so a second attempt is simply not authorised.
		expect((await del()).status).toBe(401)
		const reuse = await insertActor(db, { type: 'human', email })
		expect(reuse?.email).toBe(email)
	})

	it('refuses a wrong password and changes nothing', async () => {
		const res = await del('not the password')
		expect(res.status).toBe(401)
		const [after] = await db.select().from(actors).where(eq(actors.id, me.id))
		expect(after?.name).not.toBe('Deleted user')
		expect(after?.apiKey).toBe(me.apiKey)
	})

	it('is refused for an agent key', async () => {
		const res = await del(PASSWORD, appFor(me.id, 'agent'))
		expect(res.status).toBe(403)
	})

	it('is blocked while you pay for a workspace other people use, and says which', async () => {
		const ws = await insertWorkspace(db, me.id, { name: 'Shared HQ' })
		const colleague = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: colleague.id, role: 'member' })

		const preview = await app.request(jsonGet('/api/account/deletion-preview'))
		expect(preview.status).toBe(200)
		const body = (await preview.json()) as {
			can_delete: boolean
			blockers: Array<{ code: string; workspace_name: string }>
			leaving: Array<{ other_members: number }>
		}
		expect(body.can_delete).toBe(false)
		expect(body.blockers).toEqual([
			expect.objectContaining({ code: 'transfer_ownership', workspace_name: 'Shared HQ' }),
		])
		expect(body.leaving[0]?.other_members).toBe(1)

		const res = await del()
		expect(res.status).toBe(409)
		const [after] = await db.select().from(actors).where(eq(actors.id, me.id))
		expect(after?.name).not.toBe('Deleted user')
	})

	it('is allowed once ownership has been handed over', async () => {
		const ws = await insertWorkspace(db, me.id)
		const colleague = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: colleague.id, role: 'member' })
		await db
			.update(workspaces)
			.set({ billingOwnerId: colleague.id })
			.where(eq(workspaces.id, ws.id))

		expect((await del()).status).toBe(200)
		// The workspace and its other member are untouched.
		const members = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, ws.id))
		expect(members.map((m) => m.actorId)).toEqual([colleague.id])
	})

	it('is blocked while a plan you pay for is still live', async () => {
		await insertWorkspace(db, me.id, {
			name: 'Paid solo',
			settings: { billing: { plan: 'pro', stripe_subscription_id: 'sub_123', status: 'active' } },
		})
		const res = await del()
		expect(res.status).toBe(409)
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'Paid solo',
		)
	})

	it('is allowed once the plan is cancelled', async () => {
		await insertWorkspace(db, me.id, {
			settings: { billing: { plan: 'pro', stripe_subscription_id: 'sub_123', status: 'canceled' } },
		})
		expect((await del()).status).toBe(200)
	})
})
