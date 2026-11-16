/**
 * briefing-email-scheduler.ts — the summary email: one grouped mail a day, with a teaching block
 * on the first three.
 *
 * Sits beside the daily briefing push and reuses its facts (`loadBriefingFacts`,
 * `buildBriefingText`), so the email says the same numbers as the push and the For You screen.
 * It has its OWN query because the push only reaches people with a saved preferences row, a stored
 * timezone, the briefing switch on and a push device; a new sign-up has none of those.
 *
 * Who gets it (EMAIL_RECIPIENT_RULE_SQL, runnable on its own and read-only): a saved email choice
 * always wins. With no saved choice (empty column, or no row at all), any real action the person
 * authored in the activity log in the last 30 days counts as on. Everyone else is off. Two kinds
 * of activity rows are not a person's own doing and do not count: the bulk 'integration created'
 * rows and the 'notification settings created' rows.
 *
 * Rhythm: daily (the default, also when the choice is empty) or weekly. A weekly person gets a mail
 * only when the last send was WEEKLY_GAP_DAYS or more days ago, on top of the step spacing below,
 * and the mail looks back over the whole week. A day with nothing to say sends nothing and does not
 * use up the week: the next tick looks again. Off is the email switch, not a rhythm.
 *
 * When: at 08:00 UTC, or the briefing time in the person's stored timezone. A new sign-up gets
 * step 1 on or after account day 1, step 2 on or after day 3, step 3 on or after day 7. An
 * existing member with no saved choice starts at step 1 on the first tick, then gets step 2 two
 * days and step 3 four days later (the same spacing). After step 3 the mail is the plain daily
 * summary. Steps are never skipped, one mail per day at most. With nothing to say nothing is sent
 * and the step is not used up.
 *
 * Each mail has three parts (see briefing-email-text.ts): runs finished since the last mail, what
 * waits, and one next-step line chosen by plain rules from the person's role in the anchor
 * workspace (the `email_sent` event carries it as `role`: owner_admin or member). "Since the last mail" is the days since the last send, at least
 * 24 hours, at most MAX_LOOKBACK_DAYS.
 *
 * Exactly once: the step is claimed with one conditional UPDATE on the step counter and
 * `email_last_sent_on` (or an INSERT for someone with no row yet) before the mail goes out; a
 * failed send releases the claim. For a person with no saved choice the claim creates or fills the
 * row (email on, step 1) so the stop link has something to switch off.
 *
 * Marketplace pick (opt-in): for someone who switched picks on, a daily mail after the first three
 * may carry one Marketplace flow below the summary (marketplace-pick.ts), at most one every 7 days.
 * A pick only joins a mail that is already going out: with nothing to say nothing is sent, pick or
 * not. The week is claimed together with the mail and released with it.
 *
 * Production without a Resend key, APP_URL or stop-link secret: log and skip, nothing is claimed.
 * Killswitch env FEATURE_BRIEFING_EMAIL skips the tick: in production unless it is exactly 1,
 * elsewhere when it is 0. The push is not affected.
 */
import type { Database } from '@maskin/db'
import { actors, objects, workspaceMembers } from '@maskin/db/schema'
import { EmailSendError, isEmailConfigured, sendEmail } from '@maskin/email'
import type { EmailRhythm } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { buildEmailPickDismissUrl } from '../lib/email-pick-token'
import { buildEmailStopUrl } from '../lib/email-stop-link'
import { isEmailStopConfigured } from '../lib/email-stop-token'
import { localClock, localTimeReached } from '../lib/local-time'
import { logger } from '../lib/logger'
import { buildSummaryEmail, emailRole, pickNextStep } from './briefing-email-text'
import type { EmailRole, EmailStep, PickBlock } from './briefing-email-text'
import { buildBriefingText, loadBriefingFacts } from './briefing-push-scheduler'
import { loadMarketplacePick, pickWeekOpen } from './marketplace-pick'

const TICK_MS = 60_000
export const EMAIL_KILLSWITCH_ENV_VAR = 'FEATURE_BRIEFING_EMAIL'
/**
 * True when the email switch stops sending. In production only an exact "1" sends, so an unset or
 * empty value sends nothing; elsewhere only an exact "0" stops it, so tests and local runs send.
 */
export function emailSwitchedOff(env: NodeJS.ProcessEnv): boolean {
	if (env.NODE_ENV === 'production') return env[EMAIL_KILLSWITCH_ENV_VAR] !== '1'
	return env[EMAIL_KILLSWITCH_ENV_VAR] === '0'
}
/** How long after the send time a late tick may still send the "morning" mail. */
export const EMAIL_CATCH_UP_WINDOW_MINUTES = 180
/** Send time for a person with no stored timezone: 08:00 UTC. */
const DEFAULT_SEND_MINUTE = 480
/** A person with nothing to say is re-checked at most this often within the window. */
const EMPTY_RECHECK_MS = 10 * 60_000
export const ACTIVE_WINDOW_DAYS = 30
const DAY_MS = 86_400_000
const MAX_LOOKBACK_DAYS = 7
/** A weekly person is mailed when the last send is this many days back or more. */
export const WEEKLY_GAP_DAYS = 6
/** Account age (in days) at which onboarding steps 1, 2 and 3 are due. */
export const STEP_DUE_DAYS = [1, 3, 7] as const
/** Days that must pass after the previous mail before step 2 and step 3 (index = counter). */
const STEP_GAP_DAYS = [0, 2, 4] as const
const BATCH = 500

/**
 * The recipient rule as one read-only query. `sinceExpr` is the start of the activity window as a
 * SQL timestamp expression; `extra` is an optional trailing clause (paging). Run it with
 * `now() - interval '30 days'` and no extra clause to count who the rule reaches today.
 */
export function emailRecipientRuleSql(
	sinceExpr = `now() - interval '${ACTIVE_WINDOW_DAYS} days'`,
	extra = '',
): string {
	return `
SELECT
  a.id AS actor_id,
  a.email AS email,
  a.created_at AS created_at,
  p.actor_id IS NOT NULL AS has_row,
  p.email_digest_enabled AS email_digest_enabled,
  COALESCE(p.email_onboarding_step, 0) AS email_onboarding_step,
  p.email_last_sent_on::text AS email_last_sent_on,
  p.email_rhythm AS email_rhythm,
  p.timezone AS timezone,
  p.briefing_time AS briefing_time,
  COALESCE(p.marketplace_picks_enabled, false) AS marketplace_picks_enabled,
  COALESCE(p.marketplace_dismissed_loop_ids, '{}'::uuid[]) AS marketplace_dismissed_loop_ids,
  p.marketplace_pick_last_sent_on::text AS marketplace_pick_last_sent_on,
  COALESCE(p.muted_workspace_ids, '{}'::uuid[]) AS muted_workspace_ids
FROM actors a
LEFT JOIN notification_preferences p ON p.actor_id = a.id
WHERE a.type = 'human'
  AND a.email IS NOT NULL
  AND (
    p.email_digest_enabled IS TRUE
    OR (
      p.email_digest_enabled IS NULL
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.actor_id = a.id
          AND e.workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.actor_id = a.id)
          AND e.created_at > ${sinceExpr}
          AND NOT (e.entity_type = 'integration' AND e.action = 'created')
          AND NOT (e.entity_type = 'notification_preferences' AND e.action = 'created')
      )
    )
  )
${extra}`
}

export interface EmailRecipientRow {
	actorId: string
	email: string
	createdAt: Date
	hasRow: boolean
	/** True or null here: a saved "off" is never selected. Null means no saved choice. */
	emailDigestEnabled: boolean | null
	emailOnboardingStep: number
	emailLastSentOn: string | null
	/** Null means no saved rhythm, which is daily. */
	emailRhythm: string | null
	timezone: string | null
	briefingTime: number | null
	marketplacePicksEnabled: boolean
	marketplaceDismissedLoopIds: string[]
	marketplacePickLastSentOn: string | null
	mutedWorkspaceIds: string[]
}

type RawRecipient = {
	actor_id: string
	email: string
	created_at: Date | string
	has_row: boolean
	email_digest_enabled: boolean | null
	email_onboarding_step: number
	email_last_sent_on: string | null
	email_rhythm: string | null
	timezone: string | null
	briefing_time: number | null
	marketplace_picks_enabled: boolean
	marketplace_dismissed_loop_ids: string[] | string
	marketplace_pick_last_sent_on: string | null
	muted_workspace_ids: string[] | string
}

function parseUuidArray(value: string[] | string): string[] {
	if (Array.isArray(value)) return value
	const inner = value.replace(/^\{|\}$/g, '')
	return inner ? inner.split(',') : []
}

/** Read-only: who the recipient rule reaches now, in actor id order, after `after`. */
export async function selectEmailRecipients(
	db: Database,
	now: Date,
	opts: { after?: string | null; limit?: number } = {},
): Promise<EmailRecipientRow[]> {
	const since = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * 86_400_000).toISOString()
	const after = opts.after ? `AND a.id > '${opts.after.replace(/[^0-9a-f-]/gi, '')}'::uuid` : ''
	const limit = opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ''
	const rows = (await db.execute(
		sql.raw(emailRecipientRuleSql(`'${since}'::timestamptz`, `${after}\nORDER BY a.id\n${limit}`)),
	)) as unknown as RawRecipient[]
	return rows.map((r) => ({
		actorId: r.actor_id,
		email: r.email,
		createdAt: new Date(r.created_at),
		hasRow: r.has_row,
		emailDigestEnabled: r.email_digest_enabled,
		emailOnboardingStep: Number(r.email_onboarding_step),
		emailLastSentOn: r.email_last_sent_on,
		emailRhythm: r.email_rhythm,
		timezone: r.timezone,
		briefingTime: r.briefing_time === null ? null : Number(r.briefing_time),
		marketplacePicksEnabled: r.marketplace_picks_enabled === true,
		marketplaceDismissedLoopIds: parseUuidArray(r.marketplace_dismissed_loop_ids),
		marketplacePickLastSentOn: r.marketplace_pick_last_sent_on,
		mutedWorkspaceIds: parseUuidArray(r.muted_workspace_ids),
	}))
}

function dayNumber(isoDate: string): number {
	return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000)
}

/**
 * Pure: which mail is due for this person on this local date, or null. `ageDays` counts local
 * calendar days since sign-up. A person with no saved choice (an existing member) skips the
 * age wait for step 1 only; steps 2 and 3 keep their spacing from the previous send.
 */
export function dueEmailStep(
	row: Pick<
		EmailRecipientRow,
		'emailDigestEnabled' | 'emailOnboardingStep' | 'emailLastSentOn' | 'emailRhythm'
	>,
	localDate: string,
	ageDays: number,
): { step: EmailStep; nextCounter: number } | null {
	if (row.emailLastSentOn && row.emailLastSentOn >= localDate) return null
	// Weekly sits on top of everything below: the step spacing and the age wait still apply.
	if (
		row.emailRhythm === 'weekly' &&
		row.emailLastSentOn &&
		dayNumber(localDate) - dayNumber(row.emailLastSentOn) < WEEKLY_GAP_DAYS
	) {
		return null
	}
	const counter = Math.min(Math.max(row.emailOnboardingStep, 0), 3)
	if (counter === 3) return { step: 'daily', nextCounter: 3 }
	const existingMemberStart = counter === 0 && row.emailDigestEnabled === null
	if (ageDays < (STEP_DUE_DAYS[counter] as number) && !existingMemberStart) return null
	if (counter > 0 && row.emailLastSentOn) {
		const gap = dayNumber(localDate) - dayNumber(row.emailLastSentOn)
		if (gap < (STEP_GAP_DAYS[counter] as number)) return null
	}
	const next = (counter + 1) as 1 | 2 | 3
	return { step: next, nextCounter: next }
}

/**
 * Pure: how many days of finished runs the mail looks back over. Since the last mail, at least one
 * day and at most a week. The first mail looks back one day like the push; the first weekly mail
 * looks back the whole week.
 */
export function lookbackDays(
	rhythm: string | null,
	lastSentOn: string | null,
	localDate: string,
): number {
	if (!lastSentOn) return rhythm === 'weekly' ? MAX_LOOKBACK_DAYS : 1
	return Math.min(Math.max(dayNumber(localDate) - dayNumber(lastSentOn), 1), MAX_LOOKBACK_DAYS)
}

export class BriefingEmailScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	/** actorId -> epoch ms before which a person with an empty summary is not re-checked. */
	private emptyUntil = new Map<string, number>()
	private warnedUnconfigured = 0

	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('BriefingEmailScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		this.timer.unref?.()
		logger.info('BriefingEmailScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection; returns how many emails this tick sent. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		if (emailSwitchedOff(this.env)) return 0
		if (this.env.NODE_ENV === 'production' && !this.productionReady(now)) return 0
		this.running = true
		let sent = 0
		try {
			for (const [id, until] of this.emptyUntil) {
				if (until <= now.getTime()) this.emptyUntil.delete(id)
			}
			let after: string | null = null
			for (;;) {
				const batch: EmailRecipientRow[] = await selectEmailRecipients(this.db, now, {
					after,
					limit: BATCH,
				})
				for (const row of batch) {
					try {
						if (await this.processActor(row, now)) sent++
					} catch (err) {
						logger.warn('Summary email for actor failed', {
							actorId: row.actorId,
							error: String(err),
						})
					}
				}
				if (batch.length < BATCH) break
				after = (batch[batch.length - 1] as EmailRecipientRow).actorId
			}
		} finally {
			this.running = false
		}
		return sent
	}

	/** In production a missing key or app address means skip and log, never claim a day. */
	private productionReady(now: Date): boolean {
		if (isEmailConfigured(this.env) && this.appUrl() && isEmailStopConfigured()) return true
		// Once an hour, not once a minute.
		if (now.getTime() - this.warnedUnconfigured >= 60 * 60_000) {
			this.warnedUnconfigured = now.getTime()
			logger.warn(
				'Summary email skipped: RESEND_API_KEY, APP_URL or EMAIL_STOP_LINK_SECRET is not set in production',
			)
		}
		return false
	}

	private appUrl(): string | null {
		const url = this.env.APP_URL?.trim().replace(/\/+$/, '')
		return url ? url : null
	}

	private async processActor(row: EmailRecipientRow, now: Date): Promise<boolean> {
		const timezone = row.timezone ?? 'UTC'
		const sendMinute = row.timezone
			? (row.briefingTime ?? DEFAULT_SEND_MINUTE)
			: DEFAULT_SEND_MINUTE
		const clock = localTimeReached(now, timezone, sendMinute, EMAIL_CATCH_UP_WINDOW_MINUTES)
		if (!clock) return false // not yet, window over, or an invalid timezone: never guessed
		if ((this.emptyUntil.get(row.actorId) ?? 0) > now.getTime()) return false

		const created = localClock(row.createdAt, timezone)
		const ageDays = created ? dayNumber(clock.date) - dayNumber(created.date) : 0
		const due = dueEmailStep(row, clock.date, ageDays)
		if (!due) return false

		// Runs finished since the last mail: the days since it (at least 24 h), so a quiet day does
		// not drop work and a busy one is not repeated.
		const sinceDays = lookbackDays(row.emailRhythm, row.emailLastSentOn, clock.date)
		const facts = await loadBriefingFacts(
			this.db,
			row.actorId,
			row.mutedWorkspaceIds,
			now,
			sinceDays * DAY_MS,
		)
		const summary = buildBriefingText(facts)
		if (!summary) {
			this.emptyUntil.set(row.actorId, now.getTime() + EMPTY_RECHECK_MS)
			return false
		}

		const appUrl = this.appUrl() ?? 'http://localhost:5173'
		const topObjectId = summary.topObjectId
		const buttonPath = topObjectId
			? `/${summary.workspaceId}/objects/${topObjectId}`
			: `/${summary.workspaceId}`
		const { role, nextStep } = await this.nextStepFor(
			row.actorId,
			summary.workspaceId,
			summary.waiting,
		)
		const pick = await this.choosePickBlock(row, due.step, clock.date, summary.workspaceId, appUrl)
		const mail = buildSummaryEmail({
			summary,
			step: due.step,
			nextStep,
			buttonUrl: `${appUrl}${buttonPath}?surface=email&block=summary`,
			stopUrl: buildEmailStopUrl(row.actorId, this.env),
			pick: pick?.block ?? null,
		})

		const pickOn = pick ? clock.date : null
		if (!(await this.claim(row, clock.date, due.nextCounter, pickOn))) return false
		try {
			await sendEmail({ to: row.email, ...mail })
		} catch (err) {
			await this.release(row, clock.date, due.nextCounter)
			// The provider's message stays in the log; it is never sent anywhere else.
			logger.warn('Summary email send failed, claim released', {
				actorId: row.actorId,
				error: err instanceof EmailSendError ? err.providerErrorName : String(err),
			})
			return false
		}

		void capturePosthogEvent('email_sent', row.actorId, {
			workspace_id: summary.workspaceId,
			actor_id: row.actorId,
			actor_type: 'human',
			step: String(due.step),
			role,
			rhythm: row.emailRhythm === 'weekly' ? ('weekly' satisfies EmailRhythm) : 'daily',
			account_age_days: Math.max(ageDays, 0),
			pick: pick !== null,
		})
		return true
	}

	/**
	 * The person's role in the anchor workspace and the one next-step line for it. Facts are read
	 * in the order the rules need them, so a card that waits, or a plain member, costs one query.
	 */
	private async nextStepFor(
		actorId: string,
		workspaceId: string,
		waiting: number,
	): Promise<{ role: EmailRole; nextStep: string | null }> {
		const [membership] = await this.db
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
			)
			.limit(1)
		const role = emailRole(membership?.role)
		const needsSetupFacts = role === 'owner_admin' && waiting === 0
		const hasFlow = needsSetupFacts ? await this.workspaceHasFlow(workspaceId) : true
		const onlyMember = needsSetupFacts && hasFlow ? await this.isOnlyHuman(workspaceId) : false
		return { role, nextStep: pickNextStep({ role, waiting, hasFlow, onlyMember }) }
	}

	/**
	 * The pick for this mail, or null. Only for someone who switched picks on, only on the plain
	 * daily mail (never in the first three), at most one every 7 days, and only when the rule finds
	 * a flow; a dev copy without a stop-link secret cannot sign the "Not useful" link, so no pick.
	 */
	private async choosePickBlock(
		row: EmailRecipientRow,
		step: EmailStep,
		localDate: string,
		workspaceId: string,
		appUrl: string,
	): Promise<{ block: PickBlock } | null> {
		if (!row.marketplacePicksEnabled || step !== 'daily') return null
		if (!pickWeekOpen(row.marketplacePickLastSentOn, localDate)) return null
		if (!isEmailStopConfigured()) return null
		const found = await loadMarketplacePick(this.db, workspaceId, row.marketplaceDismissedLoopIds)
		if (!found) return null
		return {
			block: {
				name: found.flow.name,
				description: found.flow.description,
				why: found.why,
				url: `${appUrl}/${workspaceId}/marketplace/${found.flow.id}?surface=email&block=pick`,
				dismissUrl: buildEmailPickDismissUrl(row.actorId, found.flow.id, this.env),
			},
		}
	}

	private async workspaceHasFlow(workspaceId: string): Promise<boolean> {
		const rows = await this.db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
			.limit(1)
		return rows.length > 0
	}

	/** True when no other human (agents do not count) is a member of the workspace. */
	private async isOnlyHuman(workspaceId: string): Promise<boolean> {
		const rows = await this.db
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'human')))
			.limit(2)
		return rows.length < 2
	}

	/**
	 * Take the step with one conditional write: it only succeeds while the row still shows what
	 * this tick read. Someone with no row gets one (email on); someone with an empty choice gets it
	 * filled. A person who has switched email off since the read matches nothing.
	 */
	private async claim(
		row: EmailRecipientRow,
		localDate: string,
		counter: number,
		pickOn: string | null,
	): Promise<boolean> {
		if (!row.hasRow) {
			const inserted = await this.db.execute(sql`
				INSERT INTO notification_preferences
					(actor_id, email_digest_enabled, email_onboarding_step, email_last_sent_on)
				VALUES (${row.actorId}, true, ${counter}, ${localDate}::date)
				ON CONFLICT (actor_id) DO NOTHING
				RETURNING actor_id`)
			return (inserted as unknown as unknown[]).length > 0
		}
		const claimed = await this.db.execute(sql`
			UPDATE notification_preferences
			SET email_digest_enabled = true,
				email_onboarding_step = ${counter},
				email_last_sent_on = ${localDate}::date,
				marketplace_pick_last_sent_on = COALESCE(${pickOn}::date, marketplace_pick_last_sent_on),
				updated_at = now()
			WHERE actor_id = ${row.actorId}
				AND email_digest_enabled IS NOT DISTINCT FROM ${row.emailDigestEnabled}::boolean
				AND COALESCE(email_onboarding_step, 0) = ${row.emailOnboardingStep}
				AND email_last_sent_on IS NOT DISTINCT FROM ${row.emailLastSentOn}::date
			RETURNING actor_id`)
		return (claimed as unknown as unknown[]).length > 0
	}

	/** Undo a claim whose send failed, only if nothing else has moved the row since. */
	private async release(row: EmailRecipientRow, localDate: string, counter: number): Promise<void> {
		if (!row.hasRow) {
			await this.db.execute(sql`
				DELETE FROM notification_preferences
				WHERE actor_id = ${row.actorId}
					AND email_onboarding_step = ${counter}
					AND email_last_sent_on = ${localDate}::date`)
			return
		}
		await this.db.execute(sql`
			UPDATE notification_preferences
			SET email_digest_enabled = ${row.emailDigestEnabled}::boolean,
				email_onboarding_step = ${row.emailOnboardingStep},
				email_last_sent_on = ${row.emailLastSentOn}::date,
				marketplace_pick_last_sent_on = ${row.marketplacePickLastSentOn}::date
			WHERE actor_id = ${row.actorId}
				AND email_onboarding_step = ${counter}
				AND email_last_sent_on = ${localDate}::date`)
	}
}
