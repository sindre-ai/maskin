import { randomUUID } from 'node:crypto'
import { generateApiKey, hashPassword } from '@maskin/auth'
import { events, actors, workspaceInvitations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The route calls `capturePosthogEvent` fire-and-forget. Mock the module so
// tests can assert emit-once on success without hitting live ingestion, and so
// a rollback path can assert no-emit.
const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

// Import throttle reset AFTER the vi.mock so the module boundary is stable.
const { _resetInvitePreviewBuckets } = await import('../../lib/invite-preview-throttle')
const { generateInviteToken, hashInviteToken } = await import('../../lib/invites-token')
const { default: workspaceInvitationsRoutes } = await import('../../routes/workspace-invitations')

function app() {
	return createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes })
}

async function seedPendingInvite(opts: {
	workspaceId: string
	inviterId: string
	email?: string
	role?: string
	expiresInMs?: number
	metadata?: Record<string, unknown>
}) {
	const rawToken = generateInviteToken()
	const tokenHash = hashInviteToken(rawToken)
	const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 7 * 24 * 60 * 60 * 1000))
	const [row] = await db
		.insert(workspaceInvitations)
		.values({
			workspaceId: opts.workspaceId,
			email: opts.email ?? 'ada@example.com',
			role: opts.role ?? 'member',
			tokenHash,
			invitedByActorId: opts.inviterId,
			expiresAt,
			metadata: opts.metadata ?? {},
		})
		.returning()
	return { rawToken, invite: row }
}

describe('Invites — POST /:token/accept', () => {
	let workspaceId: string
	let inviterId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		_resetInvitePreviewBuckets()
		inviterId = getTestActorId()
		const ws = await insertWorkspace(db, inviterId)
		workspaceId = ws.id
		// Trial cap is 1 — bump to pro so most tests have headroom for the invitee.
		// Seat-cap-exceeded test explicitly leaves it on trial.
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	describe('new-signup branch', () => {
		it('creates an actor, membership, invite=accepted, events row, returns api_key + workspaceId', async () => {
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'newbie@example.com',
				role: 'member',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: 'newbie@example.com',
					password: 'correct-horse-battery-staple',
					name: 'Newbie',
				}),
			)

			expect(res.status).toBe(201)
			const body = (await res.json()) as {
				actor: { id: string; email: string; api_key: string; name: string }
				workspaceId: string
			}
			expect(body.workspaceId).toBe(workspaceId)
			expect(body.actor.email).toBe('newbie@example.com')
			expect(body.actor.name).toBe('Newbie')
			expect(body.actor.api_key).toMatch(/^ank_/)

			// Actor row exists with a hashed password (never persisted plaintext).
			const [actorRow] = await db.select().from(actors).where(eq(actors.id, body.actor.id))
			expect(actorRow.type).toBe('human')
			expect(actorRow.passwordHash).toBeTruthy()
			expect(actorRow.passwordHash).not.toBe('correct-horse-battery-staple')
			expect(actorRow.apiKey).toBe(body.actor.api_key)

			// Membership landed ONLY in the invited workspace — cross-tenant containment.
			const memberships = await db
				.select()
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, body.actor.id))
			expect(memberships).toHaveLength(1)
			expect(memberships[0].workspaceId).toBe(workspaceId)
			expect(memberships[0].role).toBe('member')

			// Invite flipped to accepted with the new actor recorded.
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('accepted')
			expect(after.acceptedAt).toBeInstanceOf(Date)
			expect(after.acceptedByActorId).toBe(body.actor.id)

			// Events row inserted for the join.
			const eventRows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'workspace_member'), eq(events.entityId, body.actor.id)))
			expect(eventRows).toHaveLength(1)
			expect(eventRows[0].action).toBe('created')
			expect((eventRows[0].data as Record<string, unknown>).from_invite).toBe(true)

			// PostHog emit-once for workspace_member_joined with from_invite: true.
			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_joined',
				body.actor.id,
				expect.objectContaining({ from_invite: true, workspace_id: workspaceId }),
			)
		})

		it('rejects when signup email does not match invite email (400)', async () => {
			const { rawToken } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'ada@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: 'someone-else@example.com',
					password: 'correct-horse-battery-staple',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
		})

		it('rejects when an actor with this email already exists (409)', async () => {
			await insertActor(db, { email: 'ada@example.com', name: 'Existing Ada' })
			const { rawToken } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'ada@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: 'ada@example.com',
					password: 'correct-horse-battery-staple',
				}),
			)

			expect(res.status).toBe(409)
		})
	})

	describe('authenticated-accept branch', () => {
		it('accepts when the current actor exists and email matches (sub-branches 2/3)', async () => {
			const invitee = await insertActor(db, {
				email: 'zoe@example.com',
				apiKey: generateApiKey().key,
			})
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'Zoe@Example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)

			expect(res.status).toBe(200)
			const body = (await res.json()) as { workspaceId: string; actorId: string }
			expect(body.workspaceId).toBe(workspaceId)
			expect(body.actorId).toBe(invitee.id)

			// Membership landed only in the invited workspace.
			const memberships = await db
				.select()
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, invitee.id))
			expect(memberships).toHaveLength(1)
			expect(memberships[0].workspaceId).toBe(workspaceId)

			// Metadata unchanged (email matched, case-insensitively).
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('accepted')
			expect(after.metadata).toEqual({})

			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_joined',
				invitee.id,
				expect.objectContaining({ from_invite: true, email_mismatch: false }),
			)
		})

		it('sets metadata.email_mismatch=true when the current actor email differs (sub-branch 4)', async () => {
			const invitee = await insertActor(db, {
				email: 'bob-work@example.com',
				apiKey: generateApiKey().key,
			})
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'bob-personal@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)

			expect(res.status).toBe(200)
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('accepted')
			expect(after.metadata).toEqual({ email_mismatch: true })

			expect(capturePosthogEventMock).toHaveBeenCalledWith(
				'workspace_member_joined',
				invitee.id,
				expect.objectContaining({ email_mismatch: true }),
			)
		})

		it('is idempotent when the actor is already a member (invite still flips to accepted)', async () => {
			const invitee = await insertActor(db, {
				email: 'existing@example.com',
				apiKey: generateApiKey().key,
			})
			await db.insert(workspaceMembers).values({ workspaceId, actorId: invitee.id, role: 'member' })
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'existing@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)

			expect(res.status).toBe(200)
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('accepted')
			// Still just one membership row (onConflictDoNothing).
			const memberships = await db
				.select()
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.actorId, invitee.id),
						eq(workspaceMembers.workspaceId, workspaceId),
					),
				)
			expect(memberships).toHaveLength(1)
		})

		it('returns 401 when the accept is unauthenticated with no signup body', async () => {
			const { rawToken } = await seedPendingInvite({ workspaceId, inviterId })

			const res = await app().request(jsonRequest('POST', `/api/invites/${rawToken}/accept`))
			expect(res.status).toBe(401)
		})

		it('returns 401 when the Authorization header carries an unknown API key', async () => {
			const { rawToken } = await seedPendingInvite({ workspaceId, inviterId })

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: 'Bearer ank_notarealkey',
				}),
			)
			expect(res.status).toBe(401)
		})
	})

	describe('lifecycle errors', () => {
		it('returns 404 when no invite matches the token', async () => {
			const rawToken = generateInviteToken()
			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: 'x@example.com',
					password: 'correct-horse-battery-staple',
				}),
			)
			expect(res.status).toBe(404)
		})

		it('returns 410 when the invite is expired', async () => {
			const invitee = await insertActor(db, {
				email: 'exp@example.com',
				apiKey: generateApiKey().key,
			})
			// Seed as pending but with a past expiresAt.
			const { rawToken } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'exp@example.com',
				expiresInMs: -60_000,
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)
			expect(res.status).toBe(410)
		})

		it('returns 410 when the invite has been revoked', async () => {
			const invitee = await insertActor(db, {
				email: 'rev@example.com',
				apiKey: generateApiKey().key,
			})
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId,
				inviterId,
				email: 'rev@example.com',
			})
			await db
				.update(workspaceInvitations)
				.set({ status: 'revoked', revokedAt: new Date(), revokedByActorId: inviterId })
				.where(eq(workspaceInvitations.id, invite.id))

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)
			expect(res.status).toBe(410)
		})

		it('rejects with 403 SEAT_CAP_EXCEEDED and leaves the invite pending', async () => {
			// Fresh trial-tier workspace: seat cap is 1 (owner alone), so the
			// invitee overflow trips the cap.
			const seatCapWs = await insertWorkspace(db, inviterId, { name: 'Seat Cap WS' })

			const invitee = await insertActor(db, {
				email: 'overflow@example.com',
				apiKey: generateApiKey().key,
			})
			const { rawToken, invite } = await seedPendingInvite({
				workspaceId: seatCapWs.id,
				inviterId,
				email: 'overflow@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, undefined, {
					Authorization: `Bearer ${invitee.apiKey}`,
				}),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('SEAT_CAP_EXCEEDED')
			expect(body.error.workspace_id).toBe(seatCapWs.id)
			expect(body.error.plan).toBe('trial')
			expect(body.error.cap).toBe(1)

			// Invite must remain pending so the admin can upgrade + the invitee retries.
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('pending')
			expect(after.acceptedByActorId).toBeNull()

			// Overflow actor was NOT attached.
			const memberships = await db
				.select()
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, invitee.id))
			expect(memberships).toHaveLength(0)

			// No PostHog emit on the rollback path.
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('seat cap on new-signup rolls back the actor insert (invite pending, no actor)', async () => {
			// Same fresh trial-tier workspace: 1 seat, filled by the owner.
			const seatCapWs = await insertWorkspace(db, inviterId, { name: 'Seat Cap Signup WS' })

			const { rawToken, invite } = await seedPendingInvite({
				workspaceId: seatCapWs.id,
				inviterId,
				email: 'rollback@example.com',
			})

			const res = await app().request(
				jsonRequest('POST', `/api/invites/${rawToken}/accept`, {
					email: 'rollback@example.com',
					password: 'correct-horse-battery-staple',
				}),
			)

			expect(res.status).toBe(403)

			// Invite must stay pending, and the actor insert must have rolled back.
			const [after] = await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invite.id))
			expect(after.status).toBe('pending')

			const created = await db
				.select({ id: actors.id })
				.from(actors)
				.where(eq(actors.email, 'rollback@example.com'))
			expect(created).toHaveLength(0)
		})
	})
})

describe('Invites — GET /preview', () => {
	let workspaceId: string
	let workspaceName: string
	let inviterId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		_resetInvitePreviewBuckets()
		inviterId = getTestActorId()
		const ws = await insertWorkspace(db, inviterId, { name: 'Preview WS' })
		workspaceId = ws.id
		workspaceName = ws.name
	})

	it('returns workspace + inviter metadata for a valid pending token', async () => {
		const { rawToken } = await seedPendingInvite({
			workspaceId,
			inviterId,
			email: 'Preview@Example.com',
		})

		const res = await app().request(
			jsonGet(`/api/invites/preview?token=${encodeURIComponent(rawToken)}`),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('pending')
		expect(body.workspaceId).toBe(workspaceId)
		expect(body.workspaceName).toBe(workspaceName)
		expect(body.inviteEmail).toBe('Preview@Example.com')
		expect(body.inviterName).toBeTruthy()
		expect(body.expiresAt).toEqual(expect.any(String))
	})

	it('returns 404 with status-only body when no invite matches the token', async () => {
		const rawToken = generateInviteToken()
		const res = await app().request(
			jsonGet(`/api/invites/preview?token=${encodeURIComponent(rawToken)}`),
		)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body).toEqual({ status: 'not_found' })
		expect(body.workspaceId).toBeUndefined()
		expect(body.workspaceName).toBeUndefined()
	})

	it('returns 410 with status-only body when the invite is revoked', async () => {
		const { rawToken, invite } = await seedPendingInvite({ workspaceId, inviterId })
		await db
			.update(workspaceInvitations)
			.set({ status: 'revoked', revokedAt: new Date(), revokedByActorId: inviterId })
			.where(eq(workspaceInvitations.id, invite.id))

		const res = await app().request(
			jsonGet(`/api/invites/preview?token=${encodeURIComponent(rawToken)}`),
		)
		expect(res.status).toBe(410)
		const body = await res.json()
		expect(body).toEqual({ status: 'revoked' })
		expect(body.workspaceName).toBeUndefined()
	})

	it('returns 410 with status-only body when the invite has expired', async () => {
		const { rawToken } = await seedPendingInvite({
			workspaceId,
			inviterId,
			expiresInMs: -60_000,
		})

		const res = await app().request(
			jsonGet(`/api/invites/preview?token=${encodeURIComponent(rawToken)}`),
		)
		expect(res.status).toBe(410)
		const body = await res.json()
		expect(body).toEqual({ status: 'expired' })
		expect(body.workspaceName).toBeUndefined()
	})
})
