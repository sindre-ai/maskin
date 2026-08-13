import { EmailSendError } from '@maskin/email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActor, buildWorkspace } from '../factories'
import { createTestContext } from '../setup'

const sendEmail = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>()
const renderTemplate =
	vi.fn<(name: string, props: unknown) => Promise<{ html: string; text: string }>>()

vi.mock('@maskin/email', async () => {
	const actual = await vi.importActual<typeof import('@maskin/email')>('@maskin/email')
	return {
		...actual,
		sendEmail: (...args: unknown[]) => sendEmail(...args),
		renderTemplate: (name: string, props: unknown) => renderTemplate(name, props),
	}
})

const {
	sendTeamInviteEmail,
	sendBillingReceiptEmail,
	sendOutOfCreditsAlertEmail,
	sendAccountVerificationEmail,
	sendPasswordResetEmail,
} = await import('../../lib/email-triggers')

describe('email-triggers', () => {
	beforeEach(() => {
		sendEmail.mockResolvedValue({ id: 'msg_test' })
		renderTemplate.mockResolvedValue({ html: '<p>html</p>', text: 'text' })
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('sendTeamInviteEmail', () => {
		it('renders team-invite and sends to the invitee address with inviter + workspace names', async () => {
			const invitee = buildActor({ email: 'invitee@test.com', name: 'Invitee' })
			const inviter = buildActor({ email: 'inviter@test.com', name: 'Iris Inviter' })
			const ws = buildWorkspace({ name: 'Acme Bets' })
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[invitee, inviter], [{ name: ws.name }]]

			await sendTeamInviteEmail({
				db,
				workspaceId: ws.id,
				inviteeActorId: invitee.id,
				inviterActorId: inviter.id,
				inviteUrl: 'https://app.example/ws/abc',
			})

			expect(renderTemplate).toHaveBeenCalledWith('team-invite', {
				inviterName: 'Iris Inviter',
				workspaceName: 'Acme Bets',
				inviteUrl: 'https://app.example/ws/abc',
			})
			expect(sendEmail).toHaveBeenCalledWith({
				to: 'invitee@test.com',
				subject: 'Join Acme Bets on Maskin',
				html: '<p>html</p>',
				text: 'text',
				analytics: {
					workspaceId: ws.id,
					emailType: 'team_invite',
					agentId: null,
				},
			})
		})

		it('skips send when the invitee has no email on file', async () => {
			const invitee = buildActor({ email: null, name: 'No Email Agent' })
			const inviter = buildActor({ name: 'Iris Inviter' })
			const ws = buildWorkspace()
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[invitee, inviter], [{ name: ws.name }]]

			await sendTeamInviteEmail({
				db,
				workspaceId: ws.id,
				inviteeActorId: invitee.id,
				inviterActorId: inviter.id,
				inviteUrl: 'https://app.example/ws/abc',
			})

			expect(sendEmail).not.toHaveBeenCalled()
			expect(renderTemplate).not.toHaveBeenCalled()
		})

		it('swallows EmailSendError and never rejects the caller', async () => {
			const invitee = buildActor({ email: 'invitee@test.com' })
			const inviter = buildActor()
			const ws = buildWorkspace()
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[invitee, inviter], [{ name: ws.name }]]
			sendEmail.mockRejectedValueOnce(new EmailSendError('bounce', 'Recipient bounced'))

			await expect(
				sendTeamInviteEmail({
					db,
					workspaceId: ws.id,
					inviteeActorId: invitee.id,
					inviterActorId: inviter.id,
					inviteUrl: 'https://app.example/ws/abc',
				}),
			).resolves.toBeUndefined()
			expect(sendEmail).toHaveBeenCalledTimes(1)
		})
	})

	describe('sendBillingReceiptEmail', () => {
		it('renders billing-receipt for the workspace owner and forwards idempotency key', async () => {
			const owner = buildActor({ email: 'owner@test.com' })
			const ws = buildWorkspace({ createdBy: owner.id, name: 'Owner WS' })
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: owner.email, workspaceName: ws.name }]]

			await sendBillingReceiptEmail({
				db,
				workspaceId: ws.id,
				amount: 20,
				currency: 'usd',
				periodStart: '2026-08-01',
				periodEnd: '2026-08-31',
				invoiceUrl: 'https://stripe.example/invoice/xyz',
				idempotencyKey: 'ch_test123',
			})

			expect(renderTemplate).toHaveBeenCalledWith('billing-receipt', {
				amount: 20,
				currency: 'usd',
				periodStart: '2026-08-01',
				periodEnd: '2026-08-31',
				invoiceUrl: 'https://stripe.example/invoice/xyz',
			})
			expect(sendEmail).toHaveBeenCalledWith({
				to: 'owner@test.com',
				subject: 'Your Maskin receipt',
				html: '<p>html</p>',
				text: 'text',
				idempotencyKey: 'ch_test123',
				analytics: {
					workspaceId: ws.id,
					emailType: 'billing_receipt',
					agentId: null,
				},
			})
		})

		it('skips send when the workspace owner has no email', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: null, workspaceName: 'Owner WS' }]]

			await sendBillingReceiptEmail({
				db,
				workspaceId: 'ws-id',
				amount: 20,
				currency: 'usd',
				periodStart: '2026-08-01',
				periodEnd: '2026-08-31',
				invoiceUrl: 'https://stripe.example/invoice/xyz',
				idempotencyKey: 'ch_test123',
			})

			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('swallows EmailSendError and never rejects the caller', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: 'owner@test.com', workspaceName: 'Owner WS' }]]
			sendEmail.mockRejectedValueOnce(new EmailSendError('rate_limited', 'Rate limit hit'))

			await expect(
				sendBillingReceiptEmail({
					db,
					workspaceId: 'ws-id',
					amount: 20,
					currency: 'usd',
					periodStart: '2026-08-01',
					periodEnd: '2026-08-31',
					invoiceUrl: 'https://stripe.example/invoice/xyz',
					idempotencyKey: 'ch_test123',
				}),
			).resolves.toBeUndefined()
		})
	})

	describe('sendAccountVerificationEmail', () => {
		it('renders account-verification and sends to the new signup with a base-URL-derived verify link', async () => {
			await sendAccountVerificationEmail({
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				name: 'Nova',
				email: 'nova@test.com',
				webAppBaseUrl: 'https://app.example',
			})

			expect(renderTemplate).toHaveBeenCalledTimes(1)
			expect(renderTemplate).toHaveBeenCalledWith('account-verification', {
				name: 'Nova',
				verificationUrl: 'https://app.example/verify-email?actor=actor-1',
			})
			expect(sendEmail).toHaveBeenCalledTimes(1)
			expect(sendEmail).toHaveBeenCalledWith({
				to: 'nova@test.com',
				subject: 'Verify your Maskin account',
				html: '<p>html</p>',
				text: 'text',
				analytics: {
					workspaceId: 'ws-1',
					emailType: 'account_verification',
					agentId: null,
				},
			})
		})

		it('swallows EmailSendError and never rejects the caller', async () => {
			sendEmail.mockRejectedValueOnce(new EmailSendError('bounce', 'Recipient bounced'))

			await expect(
				sendAccountVerificationEmail({
					workspaceId: 'ws-1',
					actorId: 'actor-1',
					name: 'Nova',
					email: 'nova@test.com',
					webAppBaseUrl: 'https://app.example',
				}),
			).resolves.toBeUndefined()
			expect(sendEmail).toHaveBeenCalledTimes(1)
		})
	})

	describe('sendPasswordResetEmail', () => {
		it('sends password-reset for a matching human account keyed to its oldest workspace', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [
				[{ id: 'actor-9', name: 'Rita', passwordHash: 'hashed' }],
				[{ workspaceId: 'ws-primary' }],
			]

			await sendPasswordResetEmail({
				db,
				email: 'rita@test.com',
				webAppBaseUrl: 'https://app.example',
			})

			expect(renderTemplate).toHaveBeenCalledWith('password-reset', {
				name: 'Rita',
				resetUrl: 'https://app.example/reset-password?actor=actor-9',
				expiresInMinutes: 60,
			})
			expect(sendEmail).toHaveBeenCalledTimes(1)
			expect(sendEmail).toHaveBeenCalledWith({
				to: 'rita@test.com',
				subject: 'Reset your Maskin password',
				html: '<p>html</p>',
				text: 'text',
				analytics: {
					workspaceId: 'ws-primary',
					emailType: 'password_reset',
					agentId: null,
				},
			})
		})

		it('silently no-ops when the email does not match a human account', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[]]

			await sendPasswordResetEmail({
				db,
				email: 'ghost@test.com',
				webAppBaseUrl: 'https://app.example',
			})

			expect(renderTemplate).not.toHaveBeenCalled()
			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('silently no-ops when the account has no password_hash (SSO-only or agent)', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ id: 'actor-x', name: 'SSO User', passwordHash: null }]]

			await sendPasswordResetEmail({
				db,
				email: 'sso@test.com',
				webAppBaseUrl: 'https://app.example',
			})

			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('silently no-ops when the account has no workspace membership', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ id: 'actor-9', name: 'Rita', passwordHash: 'hashed' }], []]

			await sendPasswordResetEmail({
				db,
				email: 'rita@test.com',
				webAppBaseUrl: 'https://app.example',
			})

			expect(renderTemplate).not.toHaveBeenCalled()
			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('swallows EmailSendError and never rejects the caller', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [
				[{ id: 'actor-9', name: 'Rita', passwordHash: 'hashed' }],
				[{ workspaceId: 'ws-primary' }],
			]
			sendEmail.mockRejectedValueOnce(new EmailSendError('rate_limited', 'Rate limit hit'))

			await expect(
				sendPasswordResetEmail({
					db,
					email: 'rita@test.com',
					webAppBaseUrl: 'https://app.example',
				}),
			).resolves.toBeUndefined()
		})
	})

	describe('sendOutOfCreditsAlertEmail', () => {
		it('renders out-of-credits-alert for the workspace owner with workspace name from the lookup', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: 'owner@test.com', workspaceName: 'Growth WS' }]]

			await sendOutOfCreditsAlertEmail({
				db,
				workspaceId: 'ws-id',
				creditsUsed: 1000,
				creditsTotal: 1000,
				upgradeUrl: 'https://app.example/settings/billing',
				idempotencyKey: 'cross_2026-08-13',
			})

			expect(renderTemplate).toHaveBeenCalledWith('out-of-credits-alert', {
				workspaceName: 'Growth WS',
				creditsUsed: 1000,
				creditsTotal: 1000,
				upgradeUrl: 'https://app.example/settings/billing',
			})
			expect(sendEmail).toHaveBeenCalledWith({
				to: 'owner@test.com',
				subject: 'Your agents on Growth WS have paused',
				html: '<p>html</p>',
				text: 'text',
				idempotencyKey: 'cross_2026-08-13',
				analytics: {
					workspaceId: 'ws-id',
					emailType: 'out_of_credits_alert',
					agentId: null,
				},
			})
		})

		it('skips send when the workspace owner has no email', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: null, workspaceName: 'Growth WS' }]]

			await sendOutOfCreditsAlertEmail({
				db,
				workspaceId: 'ws-id',
				creditsUsed: 1000,
				creditsTotal: 1000,
				upgradeUrl: 'https://app.example/settings/billing',
				idempotencyKey: 'cross_2026-08-13',
			})

			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('swallows EmailSendError and never rejects the caller', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [[{ email: 'owner@test.com', workspaceName: 'Growth WS' }]]
			sendEmail.mockRejectedValueOnce(new EmailSendError('transport_error', 'Boom'))

			await expect(
				sendOutOfCreditsAlertEmail({
					db,
					workspaceId: 'ws-id',
					creditsUsed: 1000,
					creditsTotal: 1000,
					upgradeUrl: 'https://app.example/settings/billing',
					idempotencyKey: 'cross_2026-08-13',
				}),
			).resolves.toBeUndefined()
		})
	})
})
