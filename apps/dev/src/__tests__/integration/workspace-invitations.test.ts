import { randomUUID } from 'node:crypto'
import { workspaceInvitations, workspaceMembers, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashInviteToken } from '../../lib/invites-token'
import { countHumanMembers } from '../../lib/workspace-capacity'
import workspaceInvitationsRoutes from '../../routes/workspace-invitations'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The accept route fires an analytics event on a successful join; mock it so
// the seat-cap tests never touch live ingestion.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => 'sent' as const),
}))

describe('workspace_invitations schema', () => {
	let workspaceId: string
	let inviterId: string

	beforeEach(async () => {
		inviterId = getTestActorId()
		const ws = await insertWorkspace(db, inviterId)
		workspaceId = ws.id
	})

	it('inserts a pending row with default metadata', async () => {
		const [row] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'Ada@Example.COM',
				role: 'member',
				tokenHash: 'a'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning()

		expect(row.status).toBe('pending')
		expect(row.metadata).toEqual({})
		expect(row.email).toBe('Ada@Example.COM')
		expect(row.createdAt).toBeInstanceOf(Date)
	})

	it('rejects a second pending invite for the same (workspaceId, lower(email))', async () => {
		await db.insert(workspaceInvitations).values({
			workspaceId,
			email: 'ada@example.com',
			role: 'member',
			tokenHash: 'a'.repeat(64),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
		})

		// Different case, same email, same workspace, still pending → must fail.
		await expect(
			db.insert(workspaceInvitations).values({
				workspaceId,
				email: 'ADA@example.com',
				role: 'viewer',
				tokenHash: 'b'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			}),
		).rejects.toThrow()
	})

	it('allows a fresh pending invite once the prior one is revoked', async () => {
		const [first] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'ada@example.com',
				role: 'member',
				tokenHash: 'a'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning()

		await db
			.update(workspaceInvitations)
			.set({ status: 'revoked', revokedAt: new Date(), revokedByActorId: inviterId })
			.where(eq(workspaceInvitations.id, first.id))

		// Partial index scopes uniqueness to status='pending', so this must succeed.
		const [second] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'ada@example.com',
				role: 'member',
				tokenHash: 'c'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning()

		expect(second.id).not.toBe(first.id)
		expect(second.status).toBe('pending')
	})

	it('allows the same email as a pending invite in a different workspace', async () => {
		const otherWs = await insertWorkspace(db, inviterId, { name: 'Other Workspace' })

		await db.insert(workspaceInvitations).values({
			workspaceId,
			email: 'ada@example.com',
			role: 'member',
			tokenHash: 'a'.repeat(64),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
		})

		const [other] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId: otherWs.id,
				email: 'ada@example.com',
				role: 'member',
				tokenHash: 'b'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning()

		expect(other.workspaceId).toBe(otherWs.id)
	})

	it('cascade-deletes when the workspace is deleted', async () => {
		const [invite] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'ada@example.com',
				role: 'member',
				tokenHash: 'a'.repeat(64),
				invitedByActorId: inviterId,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			})
			.returning()

		await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
		await db.delete(workspaces).where(eq(workspaces.id, workspaceId))

		const survivors = await db
			.select()
			.from(workspaceInvitations)
			.where(eq(workspaceInvitations.id, invite.id))
		expect(survivors).toHaveLength(0)
	})

	it('supports token-hash lookup', async () => {
		const tokenHash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
		await db.insert(workspaceInvitations).values({
			workspaceId,
			email: 'ada@example.com',
			role: 'member',
			tokenHash,
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
		})

		const rows = await db
			.select()
			.from(workspaceInvitations)
			.where(eq(workspaceInvitations.tokenHash, tokenHash))

		expect(rows).toHaveLength(1)
		expect(rows[0].tokenHash).toBe(tokenHash)
	})
})

describe('seat cap on invite accept (per-seat plans)', () => {
	function invitesApp() {
		return createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes })
	}

	async function seedHumans(workspaceId: string, count: number) {
		for (let i = 0; i < count; i++) {
			const actor = await insertActor(db, { type: 'human' })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
		}
	}

	async function seedInvite(workspaceId: string, inviterId: string) {
		const email = `invitee-${randomUUID()}@test.com`
		const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
		await db.insert(workspaceInvitations).values({
			workspaceId,
			email,
			role: 'member',
			tokenHash: hashInviteToken(token),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
		})
		return { email, token }
	}

	async function setBilling(
		workspaceId: string,
		billing: { plan: string; status: string; seats?: number },
	) {
		await db.update(workspaces).set({ settings: { billing } }).where(eq(workspaces.id, workspaceId))
	}

	async function accept(token: string, email: string) {
		return invitesApp().request(
			jsonRequest('POST', `/api/invites/${token}/accept`, {
				email,
				password: 'a-long-enough-password',
				name: 'Invitee',
			}),
		)
	}

	it('blocks a fourth human on Free and leaves the invite pending', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner, { enterpriseGranted: false })
		await seedHumans(ws.id, 2) // owner + 2 = 3, Free's cap
		expect(await countHumanMembers(db, ws.id)).toBe(3)
		const { email, token } = await seedInvite(ws.id, owner)

		const res = await accept(token, email)

		expect(res.status).toBe(403)
		expect((await res.json()).error).toMatchObject({
			code: 'SEAT_CAP_EXCEEDED',
			plan: 'trial',
			cap: 3,
		})
		expect(await countHumanMembers(db, ws.id)).toBe(3)
	})

	it('admits a fourth human when Starter pays for four seats', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner, { enterpriseGranted: false })
		await seedHumans(ws.id, 2)
		await setBilling(ws.id, { plan: 'starter', status: 'active', seats: 4 })
		const { email, token } = await seedInvite(ws.id, owner)

		const res = await accept(token, email)

		expect(res.status).toBe(201)
		expect(await countHumanMembers(db, ws.id)).toBe(4)
	})

	it('blocks the join when the paid seat count is already reached', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner, { enterpriseGranted: false })
		await seedHumans(ws.id, 2)
		await setBilling(ws.id, { plan: 'pro', status: 'active', seats: 3 })
		const { email, token } = await seedInvite(ws.id, owner)

		const res = await accept(token, email)

		expect(res.status).toBe(403)
		expect((await res.json()).error).toMatchObject({ code: 'SEAT_CAP_EXCEEDED', cap: 3 })
	})

	it('keeps the static cap for a legacy paid workspace with no seats stored', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner, { enterpriseGranted: false })
		await seedHumans(ws.id, 2) // 3 humans, below Starter's legacy cap of 5
		await setBilling(ws.id, { plan: 'starter', status: 'active' })
		const { email, token } = await seedInvite(ws.id, owner)

		const res = await accept(token, email)

		expect(res.status).toBe(201)
		expect(await countHumanMembers(db, ws.id)).toBe(4)
	})
})
