/**
 * plan-limit-email.ts — the mail to the billing owner when a workspace uses up its plan.
 *
 * Sent once per workspace and billing period, the first time a start is refused or a running
 * session is stopped at 100% (the two places that already call trackPlanLimitReached). That event
 * is analytics only and remembers in memory; this is a separate call beside it.
 *
 * Off unless the workspace has the plan-limit-email flag. The flag is checked first, before a row
 * is stored or anything is sent, so a workspace that is already over its limit when this ships gets
 * nothing: only a refusal or stop after the flag is on counts.
 *
 * Exactly once: the period is claimed by inserting a plan_limit_emails row (unique on workspace,
 * period end and kind) before the mail goes out, so a restart or a second instance finds the row
 * and sends nothing. A send that fails deletes its claim so the next refusal can try again. With no
 * period end the once-only row could never be told apart from the next period, so nothing is sent.
 *
 * To: the billing owner; with none, the workspace owners. People only: an agent has no inbox.
 * Not sent for the internal workspace. Production without a Resend key or APP_URL: log and skip,
 * nothing is claimed. Percent only in the wording, never a token count, no prices, no top-up offer.
 */
import type { Database } from '@maskin/db'
import { actors, planLimitEmails, workspaceMembers, workspaces } from '@maskin/db/schema'
import { isEmailConfigured, sendEmail } from '@maskin/email'
import { and, eq, isNotNull } from 'drizzle-orm'
import { isInternalWorkspace } from '../lib/analytics/team-member'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { button, headline, paragraph, renderEmail } from './email-layout'

export const PLAN_LIMIT_EMAIL_KIND = 'plan_used_up'

const MAX_REMEMBERED = 5_000
// With no billing owner the mail goes to the workspace owners; this caps how many.
const MAX_OWNER_RECIPIENTS = 5
// In-memory guard in front of the database: a refused start repeats on every trigger and chat
// message, so the common repeat must not cost a query. The row is what makes it once-only.
const handled = new Set<string>()

const PLAN_NAME: Record<string, string> = {
	trial: 'Trial',
	starter: 'Starter',
	pro: 'Pro',
	team: 'Team',
	ultra: 'Ultra',
	enterprise: 'Enterprise',
}

export interface PlanLimitEmailInput {
	firstName: string
	workspaceName: string
	plan: string
	/** Unix milliseconds of the period end. */
	periodEnd: number
	/** The plan picker in the app. */
	planUrl: string
}

export interface PlanLimitEmail {
	subject: string
	text: string
	html: string
}

/** The first word of a person's name, or "there" when the name is empty. */
export function firstNameOf(name: string | null | undefined): string {
	return name?.trim().split(/\s+/)[0] || 'there'
}

function renewalDate(periodEnd: number): string {
	return new Date(periodEnd).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** The mail, as pure text: a paid plan and the trial each have their own wording. */
export function buildPlanLimitEmail(input: PlanLimitEmailInput): PlanLimitEmail {
	const isTrial = input.plan === 'trial'
	const planName = PLAN_NAME[input.plan] ?? input.plan
	const greeting = `Hey ${input.firstName},`
	const subject = isTrial
		? 'Your Maskin trial usage is used up'
		: 'Your Maskin plan is used up for this month'
	const body = isTrial
		? [
				`${input.workspaceName} has used all of the usage that comes with the free trial, so new work is paused. Everything you have built is still there.`,
				'To keep going, pick a plan. Work starts again as soon as you do.',
			]
		: [
				`${input.workspaceName} has used 100% of its ${planName} plan. New work waits until your plan renews on ${renewalDate(input.periodEnd)}. Nothing is lost, and everything already done stays where it is.`,
				'If you want to keep going before then, you can change plan.',
			]
	const buttonLabel = isTrial ? 'Choose a plan' : 'Change plan'
	const text = [
		greeting,
		'',
		...body.flatMap((p) => [p, '']),
		`${buttonLabel}:`,
		input.planUrl,
		'',
		'Cheers,',
		'Maskin',
	].join('\n')
	const html = renderEmail({
		preheader: isTrial
			? 'New work is paused until you pick a plan.'
			: 'New work waits until your plan renews.',
		blocks: [
			headline(greeting),
			...body.map(paragraph),
			button(input.planUrl, buttonLabel),
			paragraph('Cheers,'),
			paragraph('Maskin'),
		],
	})
	return { subject, text, html }
}

interface Recipient {
	email: string
	name: string
}

/** The billing owner; with none (or no address for them), the human owners of the workspace. */
async function loadRecipients(db: Database, workspaceId: string): Promise<Recipient[]> {
	const [ws] = await db
		.select({ billingOwnerId: workspaces.billingOwnerId })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (ws?.billingOwnerId) {
		const [owner] = await db
			.select({ email: actors.email, name: actors.name })
			.from(actors)
			.where(
				and(eq(actors.id, ws.billingOwnerId), eq(actors.type, 'human'), isNotNull(actors.email)),
			)
			.limit(1)
		if (owner?.email) return [{ email: owner.email, name: owner.name }]
	}
	const owners = await db
		.select({ email: actors.email, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
				eq(actors.type, 'human'),
				isNotNull(actors.email),
			),
		)
		.limit(MAX_OWNER_RECIPIENTS)
	return owners.flatMap((o) => (o.email ? [{ email: o.email, name: o.name }] : []))
}

function sendingAllowed(env: NodeJS.ProcessEnv): boolean {
	if (env.NODE_ENV !== 'production') return true
	return isEmailConfigured(env) && Boolean(env.APP_URL?.trim())
}

export interface NotifyPlanLimitInput {
	db: Database
	workspaceId: string
	plan: string
	/** Unix milliseconds of the period end, or null when none is known. */
	periodEnd: number | null
}

/**
 * Sends the plan-used-up mail if it is due. Fire and forget: it never throws, so a refusal is never
 * slowed down or failed by it.
 */
export async function notifyPlanLimitReached(
	input: NotifyPlanLimitInput,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const { db, workspaceId, plan, periodEnd } = input
	if (periodEnd === null) return
	// Cheapest checks first, before any query.
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.PLAN_LIMIT_EMAIL)) return
	const key = `${workspaceId}:${periodEnd}`
	if (handled.has(key)) return
	if (handled.size >= MAX_REMEMBERED) handled.clear()
	handled.add(key)
	if (isInternalWorkspace(workspaceId)) return

	let claimed = false
	const releaseClaim = async () => {
		if (!claimed) return
		claimed = false
		await db
			.delete(planLimitEmails)
			.where(
				and(
					eq(planLimitEmails.workspaceId, workspaceId),
					eq(planLimitEmails.periodEnd, new Date(periodEnd)),
					eq(planLimitEmails.kind, PLAN_LIMIT_EMAIL_KIND),
				),
			)
			.catch((err) =>
				logger.warn('Plan limit email claim not released', { workspaceId, error: String(err) }),
			)
	}
	try {
		if (!sendingAllowed(env)) {
			logger.warn('Plan limit email skipped: RESEND_API_KEY or APP_URL is not set in production', {
				workspaceId,
			})
			return
		}
		const [claim] = await db
			.insert(planLimitEmails)
			.values({ workspaceId, periodEnd: new Date(periodEnd), kind: PLAN_LIMIT_EMAIL_KIND })
			.onConflictDoNothing()
			.returning({ id: planLimitEmails.id })
		if (!claim) return
		claimed = true

		const recipients = await loadRecipients(db, workspaceId)
		if (recipients.length === 0) {
			// Nobody to tell. Release the claim but keep the in-memory mark, so a refused start that
			// repeats does not query again until the next restart.
			logger.warn('Plan limit email has no recipient', { workspaceId })
			await releaseClaim()
			return
		}
		const [ws] = await db
			.select({ name: workspaces.name })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)
		const appUrl = env.APP_URL?.trim().replace(/\/+$/, '') || 'http://localhost:5173'
		const planUrl = `${appUrl}/${workspaceId}/settings/billing?surface=email&block=plan_limit`

		let delivered = 0
		for (const person of recipients) {
			const mail = buildPlanLimitEmail({
				firstName: firstNameOf(person.name),
				workspaceName: ws?.name ?? 'Your workspace',
				plan,
				periodEnd,
				planUrl,
			})
			try {
				if (await sendEmail({ to: person.email, ...mail })) delivered++
			} catch (err) {
				logger.warn('Plan limit email send failed', { workspaceId, error: String(err) })
			}
		}
		if (delivered === 0) throw new Error('no plan limit email was delivered')
		logger.info('Plan limit email sent', { workspaceId, plan, recipients: delivered })
	} catch (err) {
		logger.warn('Plan limit email not sent', { workspaceId, error: String(err) })
		// Release the claim and the in-memory mark so the next refusal can try again.
		handled.delete(key)
		await releaseClaim()
	}
}

/** Test hook: forget what was handled. */
export function resetPlanLimitEmailForTest(): void {
	handled.clear()
}
