/**
 * briefing-email-scheduler.ts — the summary email: day 1, 3 and 7 after sign-up, then weekly.
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
 * When: at 08:00 UTC, or the briefing time in the person's stored timezone. Step 1 on or after
 * account day 1, step 2 on or after day 3, step 3 on or after day 7, then one every 7 days counted
 * from the last send. Steps are never skipped, one mail per day at most. With nothing to say
 * nothing is sent and the step is not used up.
 *
 * Exactly once: the step is claimed with one conditional UPDATE on the step counter and
 * `email_last_sent_on` (or an INSERT for someone with no row yet) before the mail goes out; a
 * failed send releases the claim. For a person with no saved choice the claim creates or fills the
 * row (email on, step 3) so the stop link has something to switch off.
 *
 * Production without a Resend key, APP_URL or stop-link secret: log and skip, nothing is claimed.
 * Killswitch env FEATURE_BRIEFING_EMAIL=0 skips the tick. The push is not affected.
 */
import type { Database } from '@maskin/db'
import { EmailSendError, isEmailConfigured, sendEmail } from '@maskin/email'
import { sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { buildEmailStopUrl } from '../lib/email-stop-link'
import { isEmailStopConfigured } from '../lib/email-stop-token'
import { localClock, localTimeReached } from '../lib/local-time'
import { logger } from '../lib/logger'
import { buildSummaryEmail } from './briefing-email-text'
import type { EmailStep } from './briefing-email-text'
import { buildBriefingText, loadBriefingFacts } from './briefing-push-scheduler'

const TICK_MS = 60_000
export const EMAIL_KILLSWITCH_ENV_VAR = 'FEATURE_BRIEFING_EMAIL'
/** How long after the send time a late tick may still send the "morning" mail. */
export const EMAIL_CATCH_UP_WINDOW_MINUTES = 180
/** Send time for a person with no stored timezone: 08:00 UTC. */
const DEFAULT_SEND_MINUTE = 480
/** A person with nothing to say is re-checked at most this often within the window. */
const EMPTY_RECHECK_MS = 10 * 60_000
export const ACTIVE_WINDOW_DAYS = 30
const WEEK_DAYS = 7
/** Account age (in days) at which onboarding steps 1, 2 and 3 are due. */
export const STEP_DUE_DAYS = [1, 3, 7] as const
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
  p.timezone AS timezone,
  p.briefing_time AS briefing_time,
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
	timezone: string | null
	briefingTime: number | null
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
	timezone: string | null
	briefing_time: number | null
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
		timezone: r.timezone,
		briefingTime: r.briefing_time === null ? null : Number(r.briefing_time),
		mutedWorkspaceIds: parseUuidArray(r.muted_workspace_ids),
	}))
}

function dayNumber(isoDate: string): number {
	return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000)
}

/**
 * Pure: which mail is due for this person on this local date, or null. `ageDays` counts local
 * calendar days since sign-up.
 */
export function dueEmailStep(
	row: Pick<EmailRecipientRow, 'emailDigestEnabled' | 'emailOnboardingStep' | 'emailLastSentOn'>,
	localDate: string,
	ageDays: number,
): { step: EmailStep; nextCounter: number } | null {
	if (row.emailLastSentOn && row.emailLastSentOn >= localDate) return null
	const weeklyDue = () =>
		!row.emailLastSentOn || dayNumber(localDate) - dayNumber(row.emailLastSentOn) >= WEEK_DAYS
	// No saved choice: an active existing member starts at the weekly summary.
	if (row.emailDigestEnabled === null) {
		return weeklyDue() ? { step: 'weekly', nextCounter: 3 } : null
	}
	const counter = Math.min(Math.max(row.emailOnboardingStep, 0), 3)
	if (counter < 3) {
		const next = (counter + 1) as 1 | 2 | 3
		return ageDays >= (STEP_DUE_DAYS[counter] as number) ? { step: next, nextCounter: next } : null
	}
	return weeklyDue() ? { step: 'weekly', nextCounter: 3 } : null
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
		if (this.env[EMAIL_KILLSWITCH_ENV_VAR] === '0') return 0
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

		const facts = await loadBriefingFacts(this.db, row.actorId, row.mutedWorkspaceIds, now)
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
		const mail = buildSummaryEmail({
			summary,
			step: due.step,
			buttonUrl: `${appUrl}${buttonPath}?surface=email`,
			stopUrl: buildEmailStopUrl(row.actorId, this.env),
		})

		if (!(await this.claim(row, clock.date, due.nextCounter))) return false
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
			account_age_days: Math.max(ageDays, 0),
		})
		return true
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
				email_last_sent_on = ${row.emailLastSentOn}::date
			WHERE actor_id = ${row.actorId}
				AND email_onboarding_step = ${counter}
				AND email_last_sent_on = ${localDate}::date`)
	}
}
