import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceInvitations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The route awaits sendInviteEmail and fires PostHog captures without awaiting.
// Both are mocked at the module boundary: no Resend call, no ingestion request.
const { capturePosthogEventMock, sendInviteEmailMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
	sendInviteEmailMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))
vi.mock('@maskin/email', () => ({ sendInviteEmail: sendInviteEmailMock }))

const { hashInviteToken } = await import('../../lib/invites-token')
const { default: workspaceInvitationsRoutes } = await import('../../routes/workspace-invitations')

const DAY_MS = 24 * 60 * 60 * 1000

// Actors survive between tests (an existing actor is what makes Branch A/C), so
// every test that needs one uses an address nothing else has used.
const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@example.com`

function app() {
	return createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes })
}

// Same middleware as createIntegrationApp but bound to an arbitrary caller, so
// the owner/admin gate can be exercised with a plain member.
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

function invite(workspaceId: string, email: string, role = 'member') {
	return jsonRequest('POST', '/api/invites', { workspaceId, email, role })
}

async function invitesFor(workspaceId: string) {
	return db
		.select()
		.from(workspaceInvitations)
		.where(eq(workspaceInvitations.workspaceId, workspaceId))
}

let seq = 0
function seedInvite(
	workspaceId: string,
	inviterId: string,
	overrides: Partial<typeof workspaceInvitations.$inferInsert> = {},
) {
	seq += 1
	return db
		.insert(workspaceInvitations)
		.values({
			workspaceId,
			email: `seeded-${seq}@example.com`,
			role: 'member',
			tokenHash: `seed-${seq}`.padEnd(64, '0'),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * DAY_MS),
			...overrides,
		})
		.returning()
}

describe('Invites — POST / (create)', () => {
	let workspaceId: string
	let callerId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		sendInviteEmailMock.mockReset()
		sendInviteEmailMock.mockResolvedValue(undefined)
		callerId = getTestActorId()
		const ws = await insertWorkspace(db, callerId)
		workspaceId = ws.id
		// Trial caps seats at 1; bump so the seat-cap test is the only one that hits it.
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	describe('Branch B — no matching actor', () => {
		it('creates a pending invite, emails it, and emits workspace_member_invited', async () => {
			const before = Date.now()
			const res = await app().request(invite(workspaceId, 'Ada@Example.COM', 'viewer'))

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.status).toBe('pending')
			expect(body.invite).toMatchObject({ email: 'Ada@Example.COM', role: 'viewer' })

			const [row] = await invitesFor(workspaceId)
			expect(row.id).toBe(body.invite.id)
			expect(row.status).toBe('pending')
			expect(row.invitedByActorId).toBe(callerId)
			const ttl = row.expiresAt.getTime() - before
			expect(ttl).toBeGreaterThan(7 * DAY_MS - 60_000)
			expect(ttl).toBeLessThan(7 * DAY_MS + 60_000)

			// One send, and the URL carries a token whose hash is what got stored.
			expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
			const sent = sendInviteEmailMock.mock.calls[0][0]
			expect(sent).toMatchObject({ to: 'Ada@Example.COM', role: 'viewer' })
			const token = new URL(sent.acceptUrl).searchParams.get('token') as string
			expect(new URL(sent.acceptUrl).pathname).toBe('/invite')
			expect(hashInviteToken(token)).toBe(row.tokenHash)
			expect(row.tokenHash).not.toContain(token)

			expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_invited',
				callerId,
				expect.objectContaining({ invite_method: 'email', workspace_id: workspaceId }),
			)

			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'workspace_invitation'), eq(events.entityId, row.id)))
			expect(event).toMatchObject({ action: 'created', actorId: callerId, workspaceId })
		})

		it('allows a new invite once the previous one was revoked', async () => {
			const [old] = await seedInvite(workspaceId, callerId, {
				email: 'ada@example.com',
				status: 'revoked',
				revokedAt: new Date(),
			})

			const res = await app().request(invite(workspaceId, 'ada@example.com'))

			expect(res.status).toBe(201)
			expect((await res.json()).invite.id).not.toBe(old.id)
		})

		it('retires an expired-but-still-pending row instead of colliding with it', async () => {
			const [stale] = await seedInvite(workspaceId, callerId, {
				email: 'ada@example.com',
				expiresAt: new Date(Date.now() - 1000),
			})

			const res = await app().request(invite(workspaceId, 'ada@example.com'))

			expect(res.status).toBe(201)
			expect((await res.json()).invite.id).not.toBe(stale.id)
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, stale.id))
			expect(after.status).toBe('expired')
			expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
		})
	})

	describe('duplicate pending invite', () => {
		it('returns 200 with the same invite and does not rotate the token or resend', async () => {
			const first = await app().request(invite(workspaceId, 'ada@example.com'))
			const firstBody = await first.json()
			const [rowBefore] = await invitesFor(workspaceId)

			// Different casing and padding still hits the same (workspace, lower(email)).
			const second = await app().request(invite(workspaceId, '  ADA@example.com '))

			expect(second.status).toBe(200)
			const secondBody = await second.json()
			expect(secondBody.status).toBe('pending')
			expect(secondBody.invite.id).toBe(firstBody.invite.id)
			const rows = await invitesFor(workspaceId)
			expect(rows).toHaveLength(1)
			expect(rows[0].tokenHash).toBe(rowBefore.tokenHash)
			expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
			expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		})
	})

	describe('Branch A — email belongs to an existing actor', () => {
		it('adds them straight to the workspace, sends no email, and emits invited + joined', async () => {
			const email = uniqueEmail('grace')
			const existing = await insertActor(db, { email })

			const res = await app().request(invite(workspaceId, email.toUpperCase(), 'viewer'))

			expect(res.status).toBe(201)
			expect(await res.json()).toEqual({
				status: 'linked',
				member: { workspaceId, actorId: existing.id, role: 'viewer' },
			})
			const [member] = await db
				.select()
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						eq(workspaceMembers.actorId, existing.id),
					),
				)
			expect(member.role).toBe('viewer')
			expect(await invitesFor(workspaceId)).toHaveLength(0)
			expect(sendInviteEmailMock).not.toHaveBeenCalled()

			expect(capturePosthogEventMock).toHaveBeenCalledTimes(2)
			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_invited',
				callerId,
				expect.objectContaining({ invite_method: 'email' }),
			)
			// A direct link is not a redemption, so from_invite is false and the
			// distinct id is the person who joined, not the admin.
			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_joined',
				existing.id,
				expect.objectContaining({ from_invite: false, workspace_id: workspaceId }),
			)

			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'workspace_member'), eq(events.entityId, existing.id)))
			expect(event).toMatchObject({ action: 'created', actorId: callerId })
		})

		it('is blocked with 403 SEAT_CAP_EXCEEDED when the workspace is full', async () => {
			await setWorkspacePlan(db, workspaceId, 'trial')
			const email = uniqueEmail('grace')
			const existing = await insertActor(db, { email })

			const res = await app().request(invite(workspaceId, email))

			expect(res.status).toBe(403)
			expect((await res.json()).error.code).toBe('SEAT_CAP_EXCEEDED')
			const members = await db
				.select()
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						eq(workspaceMembers.actorId, existing.id),
					),
				)
			expect(members).toHaveLength(0)
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})
	})

	describe('Branch C — email already belongs to a member', () => {
		it('returns 409 and changes nothing', async () => {
			const email = uniqueEmail('grace')
			const member = await insertActor(db, { email })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })

			const res = await app().request(invite(workspaceId, email))

			expect(res.status).toBe(409)
			expect((await res.json()).error.code).toBe('CONFLICT')
			expect(await invitesFor(workspaceId)).toHaveLength(0)
			expect(sendInviteEmailMock).not.toHaveBeenCalled()
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})
	})

	describe('rate limit', () => {
		it('allows 20 invites in 24h and rejects the 21st with 429 + Retry-After', async () => {
			for (let i = 0; i < 19; i++) await seedInvite(workspaceId, callerId)

			const twentieth = await app().request(invite(workspaceId, 'twentieth@example.com'))
			expect(twentieth.status).toBe(201)

			const twentyFirst = await app().request(invite(workspaceId, 'twentyfirst@example.com'))
			expect(twentyFirst.status).toBe(429)
			expect((await twentyFirst.json()).error.code).toBe('RATE_LIMITED')
			const retryAfter = Number(twentyFirst.headers.get('Retry-After'))
			expect(Number.isFinite(retryAfter)).toBe(true)
			expect(retryAfter).toBeGreaterThan(0)
			expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60)
			expect(await invitesFor(workspaceId)).toHaveLength(20)
			expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
		})

		it('does not count invites older than 24 hours or from other workspaces', async () => {
			const other = await insertWorkspace(db, callerId)
			for (let i = 0; i < 20; i++) {
				await seedInvite(other.id, callerId)
				await seedInvite(workspaceId, callerId, {
					createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
					status: 'revoked',
				})
			}

			const res = await app().request(invite(workspaceId, 'fresh@example.com'))

			expect(res.status).toBe(201)
		})
	})

	describe('email send failure', () => {
		it('deletes the invite row, returns 502, and emits nothing', async () => {
			sendInviteEmailMock.mockRejectedValueOnce(new Error('resend said no'))

			const res = await app().request(invite(workspaceId, 'ada@example.com'))

			expect(res.status).toBe(502)
			expect((await res.json()).error.message).toContain('resend said no')
			expect(await invitesFor(workspaceId)).toHaveLength(0)
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
			const invitationEvents = await db
				.select()
				.from(events)
				.where(
					and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'workspace_invitation')),
				)
			expect(invitationEvents).toHaveLength(0)

			// The slot is free again: a retry after the outage works.
			const retry = await app().request(invite(workspaceId, 'ada@example.com'))
			expect(retry.status).toBe(201)
		})
	})

	describe('authorization and validation', () => {
		it('returns 403 for a plain workspace member', async () => {
			const plain = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: plain.id, role: 'member' })

			const res = await appAs(plain.id).request(invite(workspaceId, 'ada@example.com'))

			expect(res.status).toBe(403)
			expect(await invitesFor(workspaceId)).toHaveLength(0)
			expect(sendInviteEmailMock).not.toHaveBeenCalled()
		})

		it('returns 403 for someone outside the workspace', async () => {
			const stranger = await insertActor(db)
			const theirs = await insertWorkspace(db, stranger.id)

			const res = await app().request(invite(theirs.id, 'ada@example.com'))

			expect(res.status).toBe(403)
			expect(await invitesFor(theirs.id)).toHaveLength(0)
		})

		it('allows a human admin', async () => {
			const admin = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: admin.id, role: 'admin' })

			const res = await appAs(admin.id).request(invite(workspaceId, 'ada@example.com'))

			expect(res.status).toBe(201)
		})

		it('rejects the owner role and malformed input with 400', async () => {
			const owner = await app().request(invite(workspaceId, 'ada@example.com', 'owner'))
			const badEmail = await app().request(invite(workspaceId, 'not-an-email'))
			const badWorkspace = await app().request(invite('nope', 'ada@example.com'))

			expect(owner.status).toBe(400)
			expect(badEmail.status).toBe(400)
			expect(badWorkspace.status).toBe(400)
			expect(await invitesFor(workspaceId)).toHaveLength(0)
		})
	})
})
