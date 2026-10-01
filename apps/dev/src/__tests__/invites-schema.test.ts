import { describe, expect, it } from 'vitest'
import {
	createInviteBodySchema,
	inviteSummarySchema,
	linkedMemberResponseSchema,
	listInvitesQuerySchema,
	pendingInviteListItemSchema,
	pendingInviteResponseSchema,
	revokeInviteResponseSchema,
} from '../routes/workspace-invitations'

const UUID = '3f1c5b8e-9a2d-4c6e-8b7f-1d2e3f4a5b6c'
const ISO = '2026-10-07T10:00:00.000Z'

describe('POST /api/invites body schema', () => {
	it('accepts an email with member or viewer role', () => {
		expect(
			createInviteBodySchema.safeParse({ workspaceId: UUID, email: 'a@b.co', role: 'member' })
				.success,
		).toBe(true)
		expect(
			createInviteBodySchema.safeParse({ workspaceId: UUID, email: 'a@b.co', role: 'viewer' })
				.success,
		).toBe(true)
	})

	it('trims surrounding whitespace from the email', () => {
		const parsed = createInviteBodySchema.parse({
			workspaceId: UUID,
			email: '  a@b.co ',
			role: 'member',
		})
		expect(parsed.email).toBe('a@b.co')
	})

	it.each([
		['owner role', { workspaceId: UUID, email: 'a@b.co', role: 'owner' }],
		['admin role', { workspaceId: UUID, email: 'a@b.co', role: 'admin' }],
		['missing role', { workspaceId: UUID, email: 'a@b.co' }],
		['malformed email', { workspaceId: UUID, email: 'nope', role: 'member' }],
		['empty email', { workspaceId: UUID, email: '', role: 'member' }],
		['over-long email', { workspaceId: UUID, email: `${'a'.repeat(320)}@b.co`, role: 'member' }],
		['non-uuid workspaceId', { workspaceId: 'abc', email: 'a@b.co', role: 'member' }],
		['missing workspaceId', { email: 'a@b.co', role: 'member' }],
	])('rejects %s', (_label, body) => {
		expect(createInviteBodySchema.safeParse(body).success).toBe(false)
	})
})

describe('POST /api/invites response schemas', () => {
	const invite = { id: UUID, email: 'a@b.co', role: 'member', expiresAt: ISO }

	it('matches the pending shape', () => {
		expect(pendingInviteResponseSchema.safeParse({ status: 'pending', invite }).success).toBe(true)
		expect(inviteSummarySchema.safeParse(invite).success).toBe(true)
	})

	it('matches the linked shape', () => {
		expect(
			linkedMemberResponseSchema.safeParse({
				status: 'linked',
				member: { workspaceId: UUID, actorId: UUID, role: 'member' },
			}).success,
		).toBe(true)
	})

	it('does not let one status carry the other status payload', () => {
		expect(pendingInviteResponseSchema.safeParse({ status: 'linked', invite }).success).toBe(false)
		expect(linkedMemberResponseSchema.safeParse({ status: 'pending', invite }).success).toBe(false)
	})
})

describe('DELETE /api/invites/:id response schema', () => {
	it('is exactly { revoked: true }', () => {
		expect(revokeInviteResponseSchema.safeParse({ revoked: true }).success).toBe(true)
		expect(revokeInviteResponseSchema.safeParse({ revoked: false }).success).toBe(false)
		expect(revokeInviteResponseSchema.safeParse({}).success).toBe(false)
	})
})

describe('GET /api/invites query and item schemas', () => {
	it('requires a uuid workspaceId', () => {
		expect(listInvitesQuerySchema.safeParse({ workspaceId: UUID }).success).toBe(true)
		expect(listInvitesQuerySchema.safeParse({}).success).toBe(false)
		expect(listInvitesQuerySchema.safeParse({ workspaceId: 'abc' }).success).toBe(false)
	})

	it('describes a list row with inviter and created time', () => {
		const row = {
			id: UUID,
			email: 'a@b.co',
			role: 'viewer',
			expiresAt: ISO,
			invitedByActorId: UUID,
			invitedByName: 'Ines',
			createdAt: ISO,
		}
		expect(pendingInviteListItemSchema.safeParse(row).success).toBe(true)
		const { invitedByName: _drop, ...missing } = row
		expect(pendingInviteListItemSchema.safeParse(missing).success).toBe(false)
	})
})
