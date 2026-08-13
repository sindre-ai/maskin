import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { EmailSendError, renderTemplate, sendEmail } from '@maskin/email'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { logger } from './logger'

// Placeholder path — the token-backed verify page lands in a follow-up task.
// Kept as a query-string on the workspace-agnostic `/verify-email` route so
// links minted today keep working once the real handler ships.
const VERIFY_EMAIL_PATH = '/verify-email'
// Same story for the reset-password landing page.
const RESET_PASSWORD_PATH = '/reset-password'
// Placeholder expiry surfaced in the email body until the real token issuer
// lands — keeps the copy accurate for the plumbing round.
const PASSWORD_RESET_EXPIRES_MINUTES = 60

async function fireAndForget(
	label: string,
	context: Record<string, unknown>,
	send: () => Promise<unknown>,
): Promise<void> {
	try {
		await send()
	} catch (err) {
		if (err instanceof EmailSendError) {
			logger.error(`email.send_failed:${label}`, {
				...context,
				providerCode: err.providerCode,
				message: err.message,
			})
			return
		}
		logger.error(`email.trigger_failed:${label}`, {
			...context,
			message: err instanceof Error ? err.message : String(err),
		})
	}
}

async function lookupWorkspaceOwner(
	db: Database,
	workspaceId: string,
): Promise<{ email: string; workspaceName: string } | null> {
	const [row] = await db
		.select({
			email: actors.email,
			workspaceName: workspaces.name,
		})
		.from(workspaces)
		.leftJoin(actors, eq(actors.id, workspaces.createdBy))
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!row?.email) return null
	return { email: row.email, workspaceName: row.workspaceName }
}

export interface TeamInviteTriggerInput {
	db: Database
	workspaceId: string
	inviteeActorId: string
	inviterActorId: string
	inviteUrl: string
}

export function sendTeamInviteEmail(input: TeamInviteTriggerInput): Promise<void> {
	return fireAndForget(
		'team_invite',
		{ workspaceId: input.workspaceId, inviteeActorId: input.inviteeActorId },
		async () => {
			const [actorRows, wsRows] = await Promise.all([
				input.db
					.select({ id: actors.id, name: actors.name, email: actors.email })
					.from(actors)
					.where(inArray(actors.id, [input.inviteeActorId, input.inviterActorId])),
				input.db
					.select({ name: workspaces.name })
					.from(workspaces)
					.where(eq(workspaces.id, input.workspaceId))
					.limit(1),
			])
			const invitee = actorRows.find((a) => a.id === input.inviteeActorId)
			if (!invitee?.email) return
			const inviter = actorRows.find((a) => a.id === input.inviterActorId)
			const inviterName = inviter?.name ?? 'A teammate'
			const workspaceName = wsRows[0]?.name ?? 'your workspace'
			const { html, text } = await renderTemplate('team-invite', {
				inviterName,
				workspaceName,
				inviteUrl: input.inviteUrl,
			})
			await sendEmail({
				to: invitee.email,
				subject: `Join ${workspaceName} on Maskin`,
				html,
				text,
				analytics: {
					workspaceId: input.workspaceId,
					emailType: 'team_invite',
					agentId: null,
				},
			})
		},
	)
}

export interface BillingReceiptTriggerInput {
	db: Database
	workspaceId: string
	amount: number
	currency: string
	periodStart: string
	periodEnd: string
	invoiceUrl: string
	idempotencyKey: string
}

export function sendBillingReceiptEmail(input: BillingReceiptTriggerInput): Promise<void> {
	return fireAndForget(
		'billing_receipt',
		{ workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
		async () => {
			const owner = await lookupWorkspaceOwner(input.db, input.workspaceId)
			if (!owner) return
			const { html, text } = await renderTemplate('billing-receipt', {
				amount: input.amount,
				currency: input.currency,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				invoiceUrl: input.invoiceUrl,
			})
			await sendEmail({
				to: owner.email,
				subject: 'Your Maskin receipt',
				html,
				text,
				idempotencyKey: input.idempotencyKey,
				analytics: {
					workspaceId: input.workspaceId,
					emailType: 'billing_receipt',
					agentId: null,
				},
			})
		},
	)
}

export interface AccountVerificationTriggerInput {
	workspaceId: string
	actorId: string
	name: string
	email: string
	webAppBaseUrl: string
}

export function sendAccountVerificationEmail(
	input: AccountVerificationTriggerInput,
): Promise<void> {
	return fireAndForget(
		'account_verification',
		{ workspaceId: input.workspaceId, actorId: input.actorId },
		async () => {
			const verificationUrl = `${input.webAppBaseUrl}${VERIFY_EMAIL_PATH}?actor=${input.actorId}`
			const { html, text } = await renderTemplate('account-verification', {
				name: input.name,
				verificationUrl,
			})
			await sendEmail({
				to: input.email,
				subject: 'Verify your Maskin account',
				html,
				text,
				analytics: {
					workspaceId: input.workspaceId,
					emailType: 'account_verification',
					agentId: null,
				},
			})
		},
	)
}

export interface PasswordResetTriggerInput {
	db: Database
	email: string
	webAppBaseUrl: string
}

export function sendPasswordResetEmail(input: PasswordResetTriggerInput): Promise<void> {
	return fireAndForget('password_reset', { email: input.email }, async () => {
		const [actor] = await input.db
			.select({ id: actors.id, name: actors.name, passwordHash: actors.passwordHash })
			.from(actors)
			.where(and(eq(actors.email, input.email), eq(actors.type, 'human')))
			.limit(1)
		// Silently drop: unknown email or password-less account. The public
		// route always responds 200 so this branch stays indistinguishable
		// from the happy path externally.
		if (!actor?.passwordHash) return

		// Analytics.workspaceId keys the `email_sent` PostHog event so the
		// ship metric ("share of active workspaces with ≥1 email") can
		// aggregate by workspace. Pick the actor's oldest workspace
		// membership as a stable choice; skip if none exists (shouldn't
		// happen for a human with a password_hash, but the guard keeps
		// analytics from crashing on orphaned rows).
		const [membership] = await input.db
			.select({ workspaceId: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.actorId, actor.id))
			.orderBy(asc(workspaceMembers.joinedAt))
			.limit(1)
		if (!membership) return

		const resetUrl = `${input.webAppBaseUrl}${RESET_PASSWORD_PATH}?actor=${actor.id}`
		const { html, text } = await renderTemplate('password-reset', {
			name: actor.name,
			resetUrl,
			expiresInMinutes: PASSWORD_RESET_EXPIRES_MINUTES,
		})
		await sendEmail({
			to: input.email,
			subject: 'Reset your Maskin password',
			html,
			text,
			analytics: {
				workspaceId: membership.workspaceId,
				emailType: 'password_reset',
				agentId: null,
			},
		})
	})
}

export interface OutOfCreditsTriggerInput {
	db: Database
	workspaceId: string
	creditsUsed: number
	creditsTotal: number
	upgradeUrl: string
	idempotencyKey: string
}

export function sendOutOfCreditsAlertEmail(input: OutOfCreditsTriggerInput): Promise<void> {
	return fireAndForget(
		'out_of_credits',
		{ workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
		async () => {
			const owner = await lookupWorkspaceOwner(input.db, input.workspaceId)
			if (!owner) return
			const { html, text } = await renderTemplate('out-of-credits-alert', {
				workspaceName: owner.workspaceName,
				creditsUsed: input.creditsUsed,
				creditsTotal: input.creditsTotal,
				upgradeUrl: input.upgradeUrl,
			})
			await sendEmail({
				to: owner.email,
				subject: `Your agents on ${owner.workspaceName} have paused`,
				html,
				text,
				idempotencyKey: input.idempotencyKey,
				analytics: {
					workspaceId: input.workspaceId,
					emailType: 'out_of_credits_alert',
					agentId: null,
				},
			})
		},
	)
}
