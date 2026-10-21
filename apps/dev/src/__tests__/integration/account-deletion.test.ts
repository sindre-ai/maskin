import { OpenAPIHono } from '@hono/zod-openapi'
import { hashPassword } from '@maskin/auth'
import {
	events,
	actors,
	deviceAuthCodes,
	deviceTokens,
	liveActivityCards,
	liveActivityTokens,
	notificationPreferences,
	notifications,
	objects,
	readState,
	sessions,
	subscriptions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, sql } from './global-setup'

const { default: accountRoutes } = await import('../../routes/account')

// Deleting an account runs against real Postgres: what matters is that the person is erased while
// the records that reference them survive, in one transaction, and that the blockers hold.
describe('account deletion (integration)', () => {
	const PASSWORD = 'correct horse battery'
	let me: { id: string; apiKey: string }
	let app: OpenAPIHono

	function appFor(actorId: string, actorType = 'human', sessionManager?: unknown) {
		const a = new OpenAPIHono()
		a.use('*', async (c, next) => {
			// biome-ignore lint/suspicious/noExplicitAny: minimal context for the route under test
			const ctx = c as any
			ctx.set('db', db)
			ctx.set('actorId', actorId)
			ctx.set('actorType', actorType)
			if (sessionManager) ctx.set('sessionManager', sessionManager)
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
		await db.update(actors).set({ defaultWorkspaceId: ws.id }).where(eq(actors.id, me.id))
		const obj = await insertObject(db, ws.id, me.id, {
			title: 'My bet',
			type: 'bet',
			status: 'active',
		})

		await db.insert(notificationPreferences).values({ actorId: me.id, timezone: 'Europe/Oslo' })
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
		expect(after?.defaultWorkspaceId).toBeNull()
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
		expect(
			await db
				.select()
				.from(notificationPreferences)
				.where(eq(notificationPreferences.actorId, me.id)),
		).toEqual([])
	})

	async function pushRowsFor(actorId: string, workspaceId: string, tag: string) {
		const [device] = await db
			.insert(deviceTokens)
			.values({ actorId, platform: 'ios', apnsToken: `apns-${tag}`, environment: 'production' })
			.returning()
		await db.insert(liveActivityTokens).values([
			{ actorId, deviceId: device.id, kind: 'push_to_start', token: `start-${tag}` },
			{
				actorId,
				deviceId: device.id,
				kind: 'update',
				token: `update-${tag}`,
				workspaceId,
			},
		])
		await db.insert(liveActivityCards).values({ actorId, workspaceId })
		await db.insert(notificationPreferences).values({ actorId, timezone: 'Europe/Copenhagen' })
		await db.insert(deviceAuthCodes).values({
			deviceCodeHash: `device-${tag}`,
			userCodeHash: `user-${tag}`,
			clientSource: 'tvos',
			status: 'approved',
			actorId,
			expiresAt: new Date(Date.now() + 60_000),
		})
	}

	const pushRowCounts = async (actorId: string) => ({
		devices: (await db.select().from(deviceTokens).where(eq(deviceTokens.actorId, actorId))).length,
		activityTokens: (
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.actorId, actorId))
		).length,
		cards: (await db.select().from(liveActivityCards).where(eq(liveActivityCards.actorId, actorId)))
			.length,
		authCodes: (await db.select().from(deviceAuthCodes).where(eq(deviceAuthCodes.actorId, actorId)))
			.length,
		preferences: (
			await db
				.select()
				.from(notificationPreferences)
				.where(eq(notificationPreferences.actorId, actorId))
		).length,
	})

	it('removes the push tokens and device sign-ins of the person, and only theirs', async () => {
		const other = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, me.id)
		const otherWs = await insertWorkspace(db, other.id)
		await pushRowsFor(me.id, ws.id, `me-${me.id}`)
		await pushRowsFor(other.id, otherWs.id, `other-${other.id}`)
		expect(await pushRowCounts(me.id)).toEqual({
			devices: 1,
			activityTokens: 2,
			cards: 1,
			authCodes: 1,
			preferences: 1,
		})

		const res = await del()
		expect(res.status).toBe(200)

		expect(await pushRowCounts(me.id)).toEqual({
			devices: 0,
			activityTokens: 0,
			cards: 0,
			authCodes: 0,
			preferences: 0,
		})
		expect(await pushRowCounts(other.id)).toEqual({
			devices: 1,
			activityTokens: 2,
			cards: 1,
			authCodes: 1,
			preferences: 1,
		})
	})

	it('lets a viewer delete their own account', async () => {
		const owner = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, owner.id)
		await db.insert(workspaceMembers).values({ workspaceId: ws.id, actorId: me.id, role: 'viewer' })
		const res = await del()
		expect(res.status).toBe(200)
	})

	it('waits for the ownership-claim lock a concurrent transfer-ownership holds', async () => {
		// transfer-ownership takes this advisory lock on the NEW owner before it reads their
		// membership. If deletion did not take it too, a transfer could commit after the person's
		// memberships were deleted and leave a workspace billed to an erased account.
		let release: () => void = () => {}
		const held = new Promise<void>((r) => {
			release = r
		})
		let locked: () => void = () => {}
		const lockTaken = new Promise<void>((r) => {
			locked = r
		})
		const holder = sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${me.id}::text, 0))`
			locked()
			await held
		})
		await lockTaken

		let settled = false
		const pending = del().then((r) => {
			settled = true
			return r
		})
		await new Promise((r) => setTimeout(r, 4000))
		expect(settled).toBe(false)

		release()
		await holder
		expect((await pending).status).toBe(200)
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

	describe('with delete_sole_workspaces', () => {
		const delAll = (a = app) =>
			a.request(
				jsonRequest('POST', '/api/account/delete', {
					password: PASSWORD,
					delete_sole_workspaces: true,
				}),
			)

		async function workspaceRows(workspaceId: string) {
			return db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		}

		it('erases the workspaces only you are in, with their content, and leaves shared ones', async () => {
			const solo = await insertWorkspace(db, me.id, { name: 'Solo' })
			const soloObj = await insertObject(db, solo.id, me.id)
			const colleague = await insertActor(db, { type: 'human' })
			const shared = await insertWorkspace(db, colleague.id, { name: 'Shared' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: shared.id, actorId: me.id, role: 'member' })
			const sharedObj = await insertObject(db, shared.id, me.id)

			const preview = await app.request(
				jsonGet('/api/account/deletion-preview?delete_sole_workspaces=true'),
			)
			const body = (await preview.json()) as {
				can_delete: boolean
				leaving: Array<{ workspace_name: string; will_delete: boolean }>
			}
			expect(body.can_delete).toBe(true)
			expect(
				Object.fromEntries(body.leaving.map((l) => [l.workspace_name, l.will_delete])),
			).toEqual({ Solo: true, Shared: false })

			const res = await delAll()
			expect(res.status).toBe(200)

			expect(await workspaceRows(solo.id)).toEqual([])
			expect(await db.select().from(objects).where(eq(objects.id, soloObj.id))).toEqual([])
			expect(await workspaceRows(shared.id)).toHaveLength(1)
			expect(await db.select().from(objects).where(eq(objects.id, sharedObj.id))).toHaveLength(1)
			const [after] = await db.select().from(actors).where(eq(actors.id, me.id))
			expect(after?.name).toBe('Deleted user')
		})

		it('stops live sessions of the workspaces it erases, and leaves shared-workspace sessions alone', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			const solo = await insertWorkspace(db, me.id, { name: 'Solo' })
			const soloLive = await insertSession(db, solo.id, agent.id, me.id, { status: 'running' })
			await db.update(sessions).set({ containerId: 'c-solo' }).where(eq(sessions.id, soloLive.id))

			const colleague = await insertActor(db, { type: 'human' })
			const shared = await insertWorkspace(db, colleague.id, { name: 'Shared' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: shared.id, actorId: me.id, role: 'member' })
			const sharedLive = await insertSession(db, shared.id, agent.id, me.id, {
				status: 'running',
			})
			await db
				.update(sessions)
				.set({ containerId: 'c-shared' })
				.where(eq(sessions.id, sharedLive.id))

			const stopped: string[] = []
			const stopper = {
				stopSandboxesForPurge: vi.fn(async (rows: { id: string }[]) => {
					stopped.push(...rows.map((r) => r.id))
				}),
			}
			const res = await delAll(appFor(me.id, 'human', stopper))
			expect(res.status).toBe(200)
			expect(stopped).toEqual([soloLive.id])
			expect(await db.select().from(sessions).where(eq(sessions.id, sharedLive.id))).toHaveLength(1)
		})

		it('keeps a sole workspace when the flag is not set', async () => {
			const solo = await insertWorkspace(db, me.id)
			expect((await del()).status).toBe(200)
			expect(await workspaceRows(solo.id)).toHaveLength(1)
		})

		it('is blocked by a live plan on a workspace it would delete, and deletes nothing', async () => {
			const solo = await insertWorkspace(db, me.id, { name: 'Free' })
			const paid = await insertWorkspace(db, me.id, {
				name: 'Paid',
				settings: { billing: { plan: 'pro', stripe_subscription_id: 'sub_1', status: 'active' } },
			})
			const res = await delAll()
			expect(res.status).toBe(409)
			expect(await workspaceRows(solo.id)).toHaveLength(1)
			expect(await workspaceRows(paid.id)).toHaveLength(1)
			const [after] = await db.select().from(actors).where(eq(actors.id, me.id))
			expect(after?.name).not.toBe('Deleted user')
		})

		it('still needs a transfer for a shared workspace you pay for', async () => {
			const solo = await insertWorkspace(db, me.id, { name: 'Free' })
			const team = await insertWorkspace(db, me.id, { name: 'Team' })
			const colleague = await insertActor(db, { type: 'human' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: team.id, actorId: colleague.id, role: 'member' })
			const res = await delAll()
			expect(res.status).toBe(409)
			expect(await workspaceRows(solo.id)).toHaveLength(1)
		})

		it('rolls back the purge if the wrong password was given', async () => {
			const solo = await insertWorkspace(db, me.id)
			const res = await app.request(
				jsonRequest('POST', '/api/account/delete', {
					password: 'nope',
					delete_sole_workspaces: true,
				}),
			)
			expect(res.status).toBe(401)
			expect(await workspaceRows(solo.id)).toHaveLength(1)
		})
	})
})
