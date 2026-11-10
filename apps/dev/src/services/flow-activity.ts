/**
 * flow-activity.ts — Flow activity: tell opted-in people when one of their flows finishes a run.
 *
 * Hooks the same post-commit `events` stream the push uses (PG NOTIFY bridge), on the
 * `session_completed` event. No notification existed for a finished run, so this creates one, only
 * for people who switched Flow activity on. No polling loop and no new scheduler.
 *
 * What counts: a completed, non-chat run by an agent that ties to a flow (billing's rule, see
 * lib/flow-lookup.ts). Chat turns, failed runs and runs with no flow send nothing.
 *
 * Who: every person in the run's workspace whose Flow activity is on for a channel, unless they
 * muted that workspace. Nobody else gets anything.
 *
 * Push and Browser: a push-only notification row (stored `seen`, so it never counts toward the
 * badge or shows in the inbox) with `push_category: flow_activity`. The push fan-out then applies
 * each person's Push and Browser switches, quiet hours and the collapse key (one banner per flow).
 *
 * Email: at most one email per person per flow per hour. The hour is claimed with one conditional
 * UPDATE on `notification_preferences.flow_email_sent`, so it holds across restarts and replicas.
 * A run that finishes inside the hour waits: an in-process timer fires when the hour is up and
 * sends one email with every run since the last one. The timer is not persisted. After a restart
 * a waiting run is not lost, it is listed in the next email for that flow, which asks for runs
 * since the last email. FEATURE_BRIEFING_EMAIL=0 stops these emails too.
 */
import type { Database } from '@maskin/db'
import {
	actors,
	notificationPreferences,
	objects,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { EmailSendError, isEmailConfigured, sendEmail } from '@maskin/email'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { buildEmailStopUrl } from '../lib/email-stop-link'
import { isEmailStopConfigured } from '../lib/email-stop-token'
import { findFlowForRun } from '../lib/flow-lookup'
import type { FlowRef } from '../lib/flow-lookup'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
import { EMAIL_KILLSWITCH_ENV_VAR } from './briefing-email-scheduler'
import { PUSH_ONLY_METADATA_KEY } from './chat-notifications'
import { buildFlowActivityEmail } from './flow-activity-text'
import { channelsWanted } from './push-policy'
import type { PushPrefs } from './push-policy'

export const FLOW_ACTIVITY_KIND = 'flow_activity'
/** At most one Flow activity email per person per flow in this window. */
export const FLOW_EMAIL_WINDOW_MS = 60 * 60_000
/** Most runs read for one email; the mail lists a few and counts the rest. */
const MAX_RUNS_READ = 50

interface RunRow {
	id: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	initiatedFromObjectId: string | null
	completedAt: Date | null
}

interface Recipient {
	actorId: string
	email: string | null
	categories: Record<string, boolean>
	browserCategories: Record<string, boolean> | null
	emailEnabled: boolean
	flowEmailSent: Record<string, string> | null
}

export class FlowActivityNotifier {
	private handler: ((event: PgEvent) => void) | null = null
	/** `<actor>:<flow>` -> timer for the email held until its hour is up. */
	private timers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private env: NodeJS.ProcessEnv = process.env,
		private now: () => number = Date.now,
	) {}

	start(): void {
		this.handler = (event) => {
			if (event.entity_type === 'session' && event.action === 'session_completed') {
				this.handleEvent(event).catch((err) =>
					logger.warn('Flow activity failed', { error: String(err) }),
				)
			}
		}
		this.bridge.on('event', this.handler)
	}

	stop(): void {
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		for (const t of this.timers.values()) clearTimeout(t)
		this.timers.clear()
	}

	async handleEvent(event: PgEvent): Promise<void> {
		const [run] = await this.db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				actorId: sessions.actorId,
				triggerId: sessions.triggerId,
				initiatedFromObjectId: sessions.initiatedFromObjectId,
				completedAt: sessions.completedAt,
				status: sessions.status,
				interactive: sessions.interactive,
				actorType: actors.type,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.where(eq(sessions.id, event.entity_id))
			.limit(1)
		// Chat turns are conversation, a person's own session is not "a flow ran", and only a run
		// that completed counts.
		if (!run || run.status !== 'completed' || run.interactive || run.actorType !== 'agent') return

		const flow = await findFlowForRun(this.db, run)
		if (!flow) return

		const recipients = await this.recipients(run.workspaceId)
		for (const person of recipients) {
			try {
				await this.notifyPush(run, flow, person)
				await this.notifyEmail(run, flow, person)
			} catch (err) {
				logger.warn('Flow activity for one person failed', {
					actorId: person.actorId,
					error: String(err),
				})
			}
		}
	}

	/** People in the workspace with Flow activity on for any channel, who have not muted it. */
	private async recipients(workspaceId: string): Promise<Recipient[]> {
		const rows = await this.db
			.select({
				actorId: actors.id,
				email: actors.email,
				categories: notificationPreferences.categories,
				browserCategories: notificationPreferences.browserCategories,
				emailCategories: notificationPreferences.emailCategories,
				flowEmailSent: notificationPreferences.flowEmailSent,
			})
			.from(workspaceMembers)
			.innerJoin(actors, and(eq(actors.id, workspaceMembers.actorId), eq(actors.type, 'human')))
			.innerJoin(notificationPreferences, eq(notificationPreferences.actorId, actors.id))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					sql`NOT (${workspaceId}::uuid = ANY(${notificationPreferences.mutedWorkspaceIds}))`,
					sql`(${notificationPreferences.categories}->>'flow_activity' = 'true'
						OR ${notificationPreferences.browserCategories}->>'flow_activity' = 'true'
						OR ${notificationPreferences.emailCategories}->>'flow_activity' = 'true')`,
				),
			)
		return rows.map((r) => ({
			actorId: r.actorId,
			email: r.email,
			categories: r.categories ?? {},
			browserCategories: r.browserCategories,
			emailEnabled: r.emailCategories?.flow_activity === true,
			flowEmailSent: r.flowEmailSent,
		}))
	}

	private async notifyPush(run: RunRow, flow: FlowRef, person: Recipient): Promise<void> {
		const prefs: Pick<PushPrefs, 'categories' | 'browserCategories'> = {
			categories: {
				needs_you: true,
				conversation: true,
				digest: true,
				tips: true,
				flow_activity: false,
				...person.categories,
			},
			browserCategories: person.browserCategories ?? undefined,
		}
		const wanted = channelsWanted(prefs, FLOW_ACTIVITY_KIND)
		if (!wanted.push && !wanted.browser) return

		const line = await this.runLine(run.id)
		await this.db.transaction(async (tx) => {
			await insertNotificationsWithEvents(tx, {
				workspaceId: run.workspaceId,
				actorId: run.actorId,
				rows: [
					{
						workspaceId: run.workspaceId,
						// Same neutral FYI type chat replies use; the closed type list is not widened.
						type: 'good_news',
						title: flow.title,
						content: line,
						sourceActorId: run.actorId,
						targetActorId: person.actorId,
						objectId: flow.id,
						sessionId: run.id,
						status: 'seen',
						metadata: {
							kind: FLOW_ACTIVITY_KIND,
							flow_id: flow.id,
							push_category: FLOW_ACTIVITY_KIND,
							[PUSH_ONLY_METADATA_KEY]: true,
							// One banner per flow: a newer push replaces the older one.
							push_collapse_key: `flow:${flow.id}`,
						},
					},
				],
			})
		})
	}

	private async notifyEmail(run: RunRow, flow: FlowRef, person: Recipient): Promise<void> {
		if (!person.emailEnabled || !person.email) return
		if (this.env[EMAIL_KILLSWITCH_ENV_VAR] === '0') return
		if (this.env.NODE_ENV === 'production' && !this.productionReady()) return
		await this.sendOrHold(run.workspaceId, flow, person.actorId, person.email, run.id)
	}

	private productionReady(): boolean {
		return (
			isEmailConfigured(this.env) && Boolean(this.env.APP_URL?.trim()) && isEmailStopConfigured()
		)
	}

	/**
	 * Claim the hour for this person and flow and send one email with every run since the last one.
	 * Inside the hour, hold: one timer per person and flow fires when the hour is up.
	 */
	async sendOrHold(
		workspaceId: string,
		flow: FlowRef,
		actorId: string,
		email: string,
		triggeringRunId: string | null,
	): Promise<boolean> {
		const nowMs = this.now()
		const [prefs] = await this.db
			.select({
				flowEmailSent: notificationPreferences.flowEmailSent,
				emailCategories: notificationPreferences.emailCategories,
			})
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
			.limit(1)
		// Switched off since the run (or since the timer was set): nothing to send.
		if (!prefs || prefs.emailCategories?.flow_activity !== true) return false

		const lastIso = prefs.flowEmailSent?.[flow.id] ?? null
		const lastMs = lastIso ? Date.parse(lastIso) : Number.NaN
		if (Number.isFinite(lastMs) && nowMs - lastMs < FLOW_EMAIL_WINDOW_MS) {
			this.hold(workspaceId, flow, actorId, email, lastMs + FLOW_EMAIL_WINDOW_MS - nowMs)
			return false
		}

		if (!(await this.claim(actorId, flow.id, lastIso, new Date(nowMs)))) return false

		// Runs since the last email for this flow, but never further back than a day: switching the
		// email on after weeks must not list weeks of runs.
		const since = Number.isFinite(lastMs)
			? new Date(Math.max(lastMs, nowMs - 24 * 60 * 60_000))
			: null
		const found = await this.runsSince(workspaceId, flow, since, new Date(nowMs))
		// A first email has no earlier mail to count from: the run that triggered it is the list.
		const runs = found.length > 0 ? found : await this.singleRun(triggeringRunId)
		if (runs.length === 0) {
			await this.release(actorId, flow.id, lastIso, new Date(nowMs))
			return false
		}

		const appUrl = this.env.APP_URL?.trim().replace(/\/+$/, '') || 'http://localhost:5173'
		const mail = buildFlowActivityEmail({
			flowName: flow.title,
			runs: runs.slice(0, 5),
			runCount: runs.length,
			buttonUrl: `${appUrl}/${workspaceId}/loops/${flow.id}?surface=email`,
			stopUrl: buildEmailStopUrl(actorId, this.env, FLOW_ACTIVITY_KIND),
		})
		try {
			const sent = await sendEmail({ to: email, ...mail })
			if (!sent) {
				// No Resend key (a dev copy): nothing left the server, so the hour is not used up.
				await this.release(actorId, flow.id, lastIso, new Date(nowMs))
				return false
			}
		} catch (err) {
			await this.release(actorId, flow.id, lastIso, new Date(nowMs))
			logger.warn('Flow activity email send failed, claim released', {
				actorId,
				error: err instanceof EmailSendError ? err.providerErrorName : String(err),
			})
			return false
		}

		void capturePosthogEvent('email_sent', actorId, {
			workspace_id: workspaceId,
			actor_id: actorId,
			actor_type: 'human',
			kind: FLOW_ACTIVITY_KIND,
			run_count: runs.length,
		})
		return true
	}

	/** Wait until the hour is up, then try again. One timer per person and flow. */
	private hold(
		workspaceId: string,
		flow: FlowRef,
		actorId: string,
		email: string,
		delayMs: number,
	): void {
		const key = `${actorId}:${flow.id}`
		if (this.timers.has(key)) return
		const timer = setTimeout(
			() => {
				this.timers.delete(key)
				this.sendOrHold(workspaceId, flow, actorId, email, null).catch((err) =>
					logger.warn('Held flow activity email failed', { actorId, error: String(err) }),
				)
			},
			Math.max(0, Math.ceil(delayMs)),
		)
		timer.unref?.()
		this.timers.set(key, timer)
	}

	/**
	 * Take the hour with one conditional write: it only succeeds while the stored time for this flow
	 * is still what this call read (or empty), and Flow activity email is still on.
	 */
	private async claim(
		actorId: string,
		flowId: string,
		lastIso: string | null,
		at: Date,
	): Promise<boolean> {
		const claimed = await this.db.execute(sql`
			UPDATE notification_preferences
			SET flow_email_sent = jsonb_set(COALESCE(flow_email_sent, '{}'::jsonb), ARRAY[${flowId}::text], to_jsonb(${at.toISOString()}::text)),
				updated_at = now()
			WHERE actor_id = ${actorId}
				AND email_categories->>'flow_activity' = 'true'
				AND (flow_email_sent->>${flowId}::text) IS NOT DISTINCT FROM ${lastIso}::text
			RETURNING actor_id`)
		return (claimed as unknown as unknown[]).length > 0
	}

	/** Undo a claim whose send did not happen, only if nothing else has moved it since. */
	private async release(
		actorId: string,
		flowId: string,
		lastIso: string | null,
		at: Date,
	): Promise<void> {
		await this.db.execute(sql`
			UPDATE notification_preferences
			SET flow_email_sent = CASE
					WHEN ${lastIso}::text IS NULL THEN flow_email_sent - ${flowId}::text
					ELSE jsonb_set(flow_email_sent, ARRAY[${flowId}::text], to_jsonb(${lastIso}::text))
				END
			WHERE actor_id = ${actorId}
				AND flow_email_sent->>${flowId}::text = ${at.toISOString()}::text`)
	}

	/** Completed agent runs of this flow in the workspace after `since` and up to `until`, newest first. */
	private async runsSince(
		workspaceId: string,
		flow: FlowRef,
		since: Date | null,
		until: Date,
	): Promise<{ agentName: string; objectTitle: string | null }[]> {
		if (!since) return []
		const rows = await this.db
			.select({
				triggerId: sessions.triggerId,
				initiatedFromObjectId: sessions.initiatedFromObjectId,
				agentName: actors.name,
				objectTitle: objects.title,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.leftJoin(objects, eq(objects.id, sessions.initiatedFromObjectId))
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					eq(sessions.status, 'completed'),
					eq(sessions.interactive, false),
					eq(actors.type, 'agent'),
					gt(sessions.completedAt, since),
					lte(sessions.completedAt, until),
				),
			)
			.orderBy(desc(sessions.completedAt))
			.limit(MAX_RUNS_READ)
		const mine: { agentName: string; objectTitle: string | null }[] = []
		for (const row of rows) {
			const ref = await findFlowForRun(this.db, {
				workspaceId,
				triggerId: row.triggerId,
				initiatedFromObjectId: row.initiatedFromObjectId,
			})
			if (ref?.id === flow.id) mine.push({ agentName: row.agentName, objectTitle: row.objectTitle })
		}
		return mine
	}

	private async singleRun(
		runId: string | null,
	): Promise<{ agentName: string; objectTitle: string | null }[]> {
		if (!runId) return []
		const [row] = await this.db
			.select({ agentName: actors.name, objectTitle: objects.title })
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.leftJoin(objects, eq(objects.id, sessions.initiatedFromObjectId))
			.where(eq(sessions.id, runId))
			.limit(1)
		return row ? [row] : []
	}

	private async runLine(runId: string): Promise<string> {
		const [run] = await this.singleRun(runId)
		if (!run) return 'A run finished'
		return run.objectTitle
			? `${run.agentName} finished '${run.objectTitle}'`
			: `${run.agentName} finished a task`
	}
}
