import type { Database } from '@maskin/db'
import { actors, workspaces } from '@maskin/db/schema'
import { EmailSendError, renderTemplate, sendEmail } from '@maskin/email'
import { eq, inArray } from 'drizzle-orm'
import { logger } from './logger'

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
