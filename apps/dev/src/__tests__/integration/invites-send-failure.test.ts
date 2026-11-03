import { workspaceInvitations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// The other invite tests mock sendInviteEmail itself, which is a fair way to
// test the route's own logic but is exactly what hid the Resend bug: the SDK
// resolves with { data: null, error } instead of throwing. Here the real
// @maskin/email and the real Resend SDK run, and only the HTTP call underneath
// them (global fetch) is stubbed, so the SDK's actual error behaviour is what
// the route sees. (vi.mock('resend') can't reach it: the workspace package is
// loaded outside Vitest's module graph.)
const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

const { generateInviteToken, hashInviteToken } = await import('../../lib/invites-token')
const { default: workspaceInvitationsRoutes } = await import('../../routes/workspace-invitations')

const fetchMock = vi.fn()

const resendAccepts = () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
const resendRejects = () =>
	new Response(
		JSON.stringify({
			name: 'validation_error',
			message: 'the maskin-test.example domain is not verified',
			statusCode: 403,
		}),
		{ status: 403 },
	)

function app() {
	return createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes })
}

describe('Invites — email send failure through the real sendInviteEmail', () => {
	let workspaceId: string
	let callerId: string

	beforeEach(async () => {
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		vi.stubEnv('APP_URL', 'https://app.maskin-test.example')
		callerId = getTestActorId()
		const ws = await insertWorkspace(db, callerId)
		workspaceId = ws.id
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('POST / sends through Resend on success', async () => {
		fetchMock.mockImplementation(async () => resendAccepts())

		const res = await app().request(
			jsonRequest('POST', '/api/invites', { workspaceId, email: 'ok@example.com', role: 'member' }),
		)

		expect(res.status).toBe(201)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe('https://api.resend.com/emails')
		const sent = JSON.parse(init.body)
		expect(sent.to).toBe('ok@example.com')
		expect(sent.text).toContain('https://app.maskin-test.example/invite?token=')
	})

	it('POST / deletes the invite and returns 502 when Resend rejects it, without leaking the provider message', async () => {
		fetchMock.mockImplementation(async () => resendRejects())

		const res = await app().request(
			jsonRequest('POST', '/api/invites', {
				workspaceId,
				email: 'bounce@example.com',
				role: 'member',
			}),
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(res.status).toBe(502)
		const raw = await res.text()
		expect(raw).toContain('Failed to send invite email')
		expect(raw).not.toContain('maskin-test.example domain')
		expect(raw).not.toContain('validation_error')
		expect(
			await db
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.workspaceId, workspaceId)),
		).toHaveLength(0)
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('POST /:id/resend restores the previous token and returns 502 when Resend rejects it', async () => {
		const rawToken = generateInviteToken()
		const [invite] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email: 'bounce@example.com',
				role: 'member',
				tokenHash: hashInviteToken(rawToken),
				invitedByActorId: callerId,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			})
			.returning()
		fetchMock.mockImplementation(async () => resendRejects())

		const res = await app().request(jsonRequest('POST', `/api/invites/${invite.id}/resend`))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(res.status).toBe(502)
		expect(await res.text()).not.toContain('maskin-test.example domain')
		const [after] = await db
			.select()
			.from(workspaceInvitations)
			.where(eq(workspaceInvitations.id, invite.id))
		expect(after.tokenHash).toBe(invite.tokenHash)
		expect(after.expiresAt.getTime()).toBe(invite.expiresAt.getTime())
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
