import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, workspaceInvitations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { capturePosthogEventMock, sendInviteEmailMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
	sendInviteEmailMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))
vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendInviteEmail: sendInviteEmailMock,
}))

const { _resetInvitePreviewBuckets } = await import('../../lib/invite-preview-throttle')
const { generateInviteToken, hashInviteToken } = await import('../../lib/invites-token')
const { default: workspaceInvitationsRoutes } = await import('../../routes/workspace-invitations')

const DAY_MS = 24 * 60 * 60 * 1000

// An accept creates a real actor and actors persist between tests, so every
// invitee that gets redeemed needs an address nothing else has used.
const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@example.com`

function app() {
	return createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes })
}

function appAs(actorId: string) {
	const a = new OpenAPIHono<{
		Variables: { db: Database; actorId: string; actorType: string }
	}>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	a.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	a.route('/api/invites', workspaceInvitationsRoutes)
	return a
}

async function seedInvite(
	workspaceId: string,
	inviterId: string,
	overrides: Partial<typeof workspaceInvitations.$inferInsert> = {},
) {
	const rawToken = generateInviteToken()
	const [row] = await db
		.insert(workspaceInvitations)
		.values({
			workspaceId,
			email: `${rawToken.slice(0, 8).toLowerCase()}@example.com`,
			role: 'member',
			tokenHash: hashInviteToken(rawToken),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + DAY_MS),
			...overrides,
		})
		.returning()
	return { rawToken, invite: row }
}

async function reload(id: string) {
	const [row] = await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, id))
	return row
}

function tokenFromLastEmail(): string {
	const { acceptUrl } = sendInviteEmailMock.mock.lastCall?.[0] as { acceptUrl: string }
	return new URL(acceptUrl).searchParams.get('token') as string
}

describe('Invites — admin lifecycle (resend, revoke, list)', () => {
	let workspaceId: string
	let callerId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		sendInviteEmailMock.mockReset()
		sendInviteEmailMock.mockResolvedValue(undefined)
		_resetInvitePreviewBuckets()
		callerId = getTestActorId()
		const ws = await insertWorkspace(db, callerId)
		workspaceId = ws.id
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	describe('POST /:id/resend', () => {
		it('rotates the token, resets expiry to 7 days, re-sends, and emits workspace_member_invited', async () => {
			const email = uniqueEmail('ada')
			const { rawToken: oldToken, invite } = await seedInvite(workspaceId, callerId, {
				email: email,
				role: 'viewer',
			})

			const before = Date.now()
			const res = await app().request(jsonRequest('POST', `/api/invites/${invite.id}/resend`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.status).toBe('pending')
			expect(body.invite).toMatchObject({ id: invite.id, email: email, role: 'viewer' })

			const after = await reload(invite.id)
			expect(after.tokenHash).not.toBe(invite.tokenHash)
			const ttl = after.expiresAt.getTime() - before
			expect(ttl).toBeGreaterThan(7 * DAY_MS - 60_000)
			expect(ttl).toBeLessThan(7 * DAY_MS + 60_000)

			expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
			expect(sendInviteEmailMock.mock.calls[0][0]).toMatchObject({
				to: email,
				role: 'viewer',
			})
			const newToken = tokenFromLastEmail()
			expect(newToken).not.toBe(oldToken)
			expect(hashInviteToken(newToken)).toBe(after.tokenHash)

			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_invited',
				callerId,
				expect.objectContaining({ invite_method: 'email', workspace_id: workspaceId }),
			)

			// The old link is dead, the new one redeems.
			const oldAccept = await app().request(
				jsonRequest('POST', `/api/invites/${oldToken}/accept`, {
					email: email,
					password: 'correct-horse-battery-staple',
				}),
			)
			expect(oldAccept.status).toBe(404)
			const newAccept = await app().request(
				jsonRequest('POST', `/api/invites/${newToken}/accept`, {
					email: email,
					password: 'correct-horse-battery-staple',
				}),
			)
			expect(newAccept.status).toBe(201)
		})

		it('revives an invite that lapsed but was never flipped from pending', async () => {
			const { invite } = await seedInvite(workspaceId, callerId, {
				expiresAt: new Date(Date.now() - 1000),
			})

			const res = await app().request(jsonRequest('POST', `/api/invites/${invite.id}/resend`))

			expect(res.status).toBe(200)
			expect((await reload(invite.id)).expiresAt.getTime()).toBeGreaterThan(Date.now())
		})

		it('restores the previous token and expiry when the email fails, and returns 502', async () => {
			const { rawToken, invite } = await seedInvite(workspaceId, callerId)
			sendInviteEmailMock.mockRejectedValueOnce(new Error('resend said no'))

			const res = await app().request(jsonRequest('POST', `/api/invites/${invite.id}/resend`))

			expect(res.status).toBe(502)
			const after = await reload(invite.id)
			expect(after.tokenHash).toBe(invite.tokenHash)
			expect(after.expiresAt.getTime()).toBe(invite.expiresAt.getTime())
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
			// The link from the earlier email still redeems.
			const accept = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: invite.email,
					password: 'correct-horse-battery-staple',
				}),
			)
			expect(accept.status).toBe(201)
		})

		it('returns 409 for revoked and accepted invites, 404 for unknown ids', async () => {
			const { invite: revoked } = await seedInvite(workspaceId, callerId, { status: 'revoked' })
			const { invite: accepted } = await seedInvite(workspaceId, callerId, { status: 'accepted' })

			const r1 = await app().request(jsonRequest('POST', `/api/invites/${revoked.id}/resend`))
			const r2 = await app().request(jsonRequest('POST', `/api/invites/${accepted.id}/resend`))
			const r3 = await app().request(
				jsonRequest('POST', '/api/invites/00000000-0000-4000-8000-000000000000/resend'),
			)

			expect(r1.status).toBe(409)
			expect(r2.status).toBe(409)
			expect(r3.status).toBe(404)
			expect(sendInviteEmailMock).not.toHaveBeenCalled()
		})

		it('returns 403 for a plain member and leaves the token alone', async () => {
			const { invite } = await seedInvite(workspaceId, callerId)
			const plain = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: plain.id, role: 'member' })

			const res = await appAs(plain.id).request(
				jsonRequest('POST', `/api/invites/${invite.id}/resend`),
			)

			expect(res.status).toBe(403)
			expect((await reload(invite.id)).tokenHash).toBe(invite.tokenHash)
			expect(sendInviteEmailMock).not.toHaveBeenCalled()
		})
	})

	describe('DELETE /:id', () => {
		it('revokes the invite, records who and when, and emits workspace_invite_revoked', async () => {
			const { invite } = await seedInvite(workspaceId, callerId)

			const res = await app().request(jsonDelete(`/api/invites/${invite.id}`))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ revoked: true })
			const after = await reload(invite.id)
			expect(after.status).toBe('revoked')
			expect(after.revokedByActorId).toBe(callerId)
			expect(after.revokedAt).toBeInstanceOf(Date)

			expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
			expect(capturePosthogEventMock).toHaveBeenCalledWith('workspace_invite_revoked', callerId, {
				workspace_id: workspaceId,
				invite_id: invite.id,
				revoked_by_actor_id: callerId,
			})
			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'workspace_invitation'), eq(events.entityId, invite.id)))
			expect(event).toMatchObject({ action: 'updated', data: { status: 'revoked' } })
		})

		it('makes the invite link stop working (accept returns 410, no member is created)', async () => {
			const email = uniqueEmail('ada')
			const { rawToken, invite } = await seedInvite(workspaceId, callerId, {
				email: email,
			})
			await app().request(jsonDelete(`/api/invites/${invite.id}`))

			const accept = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: email,
					password: 'correct-horse-battery-staple',
				}),
			)

			expect(accept.status).toBe(410)
			const created = await db.select().from(actors).where(eq(actors.email, email))
			expect(created).toHaveLength(0)
		})

		it('returns 409 for an already revoked or accepted invite and 404 for an unknown id', async () => {
			const { invite: revoked } = await seedInvite(workspaceId, callerId, { status: 'revoked' })
			const { invite: accepted } = await seedInvite(workspaceId, callerId, { status: 'accepted' })

			const r1 = await app().request(jsonDelete(`/api/invites/${revoked.id}`))
			const r2 = await app().request(jsonDelete(`/api/invites/${accepted.id}`))
			const r3 = await app().request(
				jsonDelete('/api/invites/00000000-0000-4000-8000-000000000000'),
			)

			expect(r1.status).toBe(409)
			expect(r2.status).toBe(409)
			expect(r3.status).toBe(404)
			expect((await reload(accepted.id)).status).toBe('accepted')
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('returns 403 for a plain member and someone outside the workspace', async () => {
			const { invite } = await seedInvite(workspaceId, callerId)
			const plain = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: plain.id, role: 'member' })
			const stranger = await insertActor(db)

			const asMember = await appAs(plain.id).request(jsonDelete(`/api/invites/${invite.id}`))
			const asStranger = await appAs(stranger.id).request(jsonDelete(`/api/invites/${invite.id}`))

			expect(asMember.status).toBe(403)
			expect(asStranger.status).toBe(403)
			expect((await reload(invite.id)).status).toBe('pending')
		})
	})

	describe('GET /?workspaceId=', () => {
		it('returns only live pending invites for that workspace, newest first, without token data', async () => {
			const inviter = await insertActor(db, { name: 'Ines Inviter' })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: inviter.id, role: 'admin' })
			const older = await seedInvite(workspaceId, inviter.id, {
				email: 'older@example.com',
				createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
			})
			const newer = await seedInvite(workspaceId, callerId, { email: 'newer@example.com' })
			await seedInvite(workspaceId, callerId, { status: 'revoked' })
			await seedInvite(workspaceId, callerId, { status: 'accepted' })
			await seedInvite(workspaceId, callerId, { status: 'expired' })
			await seedInvite(workspaceId, callerId, { expiresAt: new Date(Date.now() - 1000) })
			const other = await insertWorkspace(db, callerId)
			await seedInvite(other.id, callerId)

			const res = await app().request(jsonGet(`/api/invites?workspaceId=${workspaceId}`))

			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<Record<string, unknown>>
			expect(body.map((r) => r.id)).toEqual([newer.invite.id, older.invite.id])
			expect(body[1]).toEqual({
				id: older.invite.id,
				email: 'older@example.com',
				role: 'member',
				expiresAt: older.invite.expiresAt.toISOString(),
				invitedByActorId: inviter.id,
				invitedByName: 'Ines Inviter',
				createdAt: older.invite.createdAt.toISOString(),
			})
			for (const row of body) {
				expect(JSON.stringify(row)).not.toContain('token')
			}
		})

		it('lets any workspace member list, including a viewer', async () => {
			await seedInvite(workspaceId, callerId)
			const viewer = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

			const res = await appAs(viewer.id).request(jsonGet(`/api/invites?workspaceId=${workspaceId}`))

			expect(res.status).toBe(200)
			expect(await res.json()).toHaveLength(1)
		})

		it('returns 403 for a non-member and 400 without a workspaceId', async () => {
			const stranger = await insertActor(db)
			await seedInvite(workspaceId, callerId)

			const outsider = await appAs(stranger.id).request(
				jsonGet(`/api/invites?workspaceId=${workspaceId}`),
			)
			const missing = await app().request(jsonGet('/api/invites'))

			expect(outsider.status).toBe(403)
			expect(missing.status).toBe(400)
		})
	})
})
