import { randomUUID } from 'node:crypto'
import { workspaceInvitations, workspaceMembers, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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
