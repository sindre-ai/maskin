import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { workspaceInvitations, workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import { buildCreateObjectBody, insertActor, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { default: invitationsRoutes } = await import('../../routes/workspace-invitations')
const { default: billingRoutes } = await import('../../routes/billing')
const { default: objectsRoutes } = await import('../../routes/objects')
const { generateInviteToken, hashInviteToken } = await import('../../lib/invites-token')

// Real authMiddleware (the role comes from its membership lookup) in front of the real
// Group D routes, so a viewer API key goes through the same path as in production. The
// cache is on (60s) so the demotion test proves the eviction, not a cache that never fills.
function createApp() {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 60_000 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		// A viewer is turned away before any route touches these.
		c.set('agentStorage' as never, {} as never)
		c.set('sessionManager' as never, {} as never)
		c.set('storageProvider' as never, {} as never)
		c.set('notifyBridge' as never, {} as never)
		await next()
	})
	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		throw err
	})
	app.route('/api/workspaces', workspacesRoutes as never)
	app.route('/api/invites', invitationsRoutes as never)
	app.route('/api/billing', billingRoutes as never)
	app.route('/api/objects', objectsRoutes as never)
	return app
}

describe('Viewer role is read-only on people and billing (Group D)', () => {
	let workspaceId: string
	let viewerId: string
	let viewerKey: string
	let memberId: string
	let memberKey: string
	let otherId: string
	let inviteId: string
	const ownerKey = 'ank_testintegration'

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerId = viewer.id
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const member = await insertActor(db, { name: 'Member' })
		memberId = member.id
		memberKey = member.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })

		const other = await insertActor(db, { name: 'Other' })
		otherId = other.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })

		const [invite] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: `${randomUUID().slice(0, 8)}@example.com`,
				role: 'member',
				tokenHash: hashInviteToken(generateInviteToken()),
				invitedByActorId: getTestActorId(),
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			})
			.returning()
		inviteId = invite.id
	})

	const auth = (key: string) => ({ Authorization: `Bearer ${key}`, 'x-workspace-id': workspaceId })
	const urls = { success_url: 'https://example.com/ok', cancel_url: 'https://example.com/no' }

	// Every Group D route a viewer must be refused on. Each is already gated on a human admin
	// or owner (or the billing owner), so a plain member gets the same 403.
	type Case = [label: string, method: string, path: string, body: unknown]
	const cases = (): Case[] => {
		const ws = `/api/workspaces/${workspaceId}`
		return [
			['members add', 'POST', `${ws}/members`, { actor_id: randomUUID() }],
			['members role change', 'PATCH', `${ws}/members/${otherId}`, { role: 'viewer' }],
			['members remove another', 'DELETE', `${ws}/members/${otherId}`, undefined],
			['transfer ownership', 'POST', `${ws}/transfer-ownership`, { new_owner_actor_id: otherId }],
			[
				'invites create',
				'POST',
				'/api/invites',
				{ workspaceId, email: 'new@example.com', role: 'member' },
			],
			['invites resend', 'POST', `/api/invites/${inviteId}/resend`, undefined],
			['invites revoke', 'DELETE', `/api/invites/${inviteId}`, undefined],
			['billing checkout', 'POST', '/api/billing/checkout', { plan: 'pro', ...urls }],
			[
				'billing credits checkout',
				'POST',
				'/api/billing/credits/checkout',
				{ amount_usd_cents: 2000, ...urls },
			],
			['billing cancel', 'POST', '/api/billing/cancel', undefined],
		]
	}

	it('returns 403 to a viewer on every Group D write', async () => {
		const app = createApp()
		const wrong: string[] = []
		for (const [label, method, path, body] of cases()) {
			const res = await app.request(jsonRequest(method, path, body, auth(viewerKey)))
			if (res.status !== 403) wrong.push(`${label}: ${res.status}`)
		}
		expect(wrong).toEqual([])
	})

	it('keeps refusing a plain member on the same routes (the human admin or owner gate)', async () => {
		const app = createApp()
		const wrong: string[] = []
		for (const [label, method, path, body] of cases()) {
			const res = await app.request(jsonRequest(method, path, body, auth(memberKey)))
			if (res.status !== 403) wrong.push(`${label}: ${res.status}`)
		}
		expect(wrong).toEqual([])
	})

	it('refuses a viewer who holds billing ownership on cancel and transfer-ownership', async () => {
		await db
			.update(workspaces)
			.set({ billingOwnerId: viewerId })
			.where(eq(workspaces.id, workspaceId))
		const app = createApp()

		const cancel = await app.request(
			jsonRequest('POST', '/api/billing/cancel', undefined, auth(viewerKey)),
		)
		expect(cancel.status).toBe(403)
		expect((await cancel.json()).error.message).toMatch(/read-only/)

		const transfer = await app.request(
			jsonRequest(
				'POST',
				`/api/workspaces/${workspaceId}/transfer-ownership`,
				{ new_owner_actor_id: otherId },
				auth(viewerKey),
			),
		)
		expect(transfer.status).toBe(403)
		expect((await transfer.json()).error.message).toMatch(/read-only/)

		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		expect(row.billingOwnerId).toBe(viewerId)
	})

	it('lets a viewer read the member list, and leave the workspace themselves', async () => {
		const app = createApp()
		const list = await app.request(
			jsonGet(`/api/workspaces/${workspaceId}/members`, auth(viewerKey)),
		)
		expect(list.status).toBe(200)

		const leave = await app.request(
			jsonDelete(`/api/workspaces/${workspaceId}/members/${viewerId}`, auth(viewerKey)),
		)
		expect(leave.status).toBe(200)
		const rows = await db
			.select()
			.from(workspaceMembers)
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, viewerId)),
			)
		expect(rows).toEqual([])
	})

	describe('demoting a member to viewer through the API', () => {
		const patchRole = (
			app: ReturnType<typeof createApp>,
			key: string,
			actorId: string,
			role: string,
		) =>
			app.request(
				jsonRequest(
					'PATCH',
					`/api/workspaces/${workspaceId}/members/${actorId}`,
					{ role },
					auth(key),
				),
			)

		it('makes the next write by that member fail with 403', async () => {
			const app = createApp()

			// The first write fills the auth cache with the member role.
			const before = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(memberKey)),
			)
			expect(before.status).toBe(201)

			const demote = await patchRole(app, ownerKey, memberId, 'viewer')
			expect(demote.status).toBe(200)
			expect((await demote.json()).role).toBe('viewer')

			// No cache wait: the role change evicted the cached membership.
			const after = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(memberKey)),
			)
			expect(after.status).toBe(403)
			expect((await after.json()).error.code).toBe('FORBIDDEN')

			const read = await app.request(jsonGet('/api/objects', auth(memberKey)))
			expect(read.status).toBe(200)
		})

		it('lets the owner restore the member, who can write again on the next request', async () => {
			const app = createApp()
			expect((await patchRole(app, ownerKey, memberId, 'viewer')).status).toBe(200)
			const blocked = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(memberKey)),
			)
			expect(blocked.status).toBe(403)

			expect((await patchRole(app, ownerKey, memberId, 'member')).status).toBe(200)
			const restored = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(memberKey)),
			)
			expect(restored.status).toBe(201)
		})

		it('still lets only an owner or admin change roles', async () => {
			const app = createApp()
			expect((await patchRole(app, memberKey, otherId, 'viewer')).status).toBe(403)
			// A viewer cannot lift their own restriction.
			expect((await patchRole(app, viewerKey, viewerId, 'member')).status).toBe(403)
		})

		it('still refuses owner as a role', async () => {
			const res = await patchRole(createApp(), ownerKey, memberId, 'owner')
			expect(res.status).toBe(400)
		})
	})
})
