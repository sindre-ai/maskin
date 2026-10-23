/**
 * briefing-push-scheduler.ts — the daily briefing push.
 *
 * Ticks about once a minute. For every actor with `briefing_enabled`, a stored (never guessed)
 * IANA timezone and at least one push device (APNs token or Web Push subscription), once the
 * actor's LOCAL clock has reached `briefing_time` it creates ONE `notifications` row that the
 * push fan-out delivers (`push_category: 'digest'`, `push_force: true`, collapse key
 * `briefing:<local date>`). Quiet hours, category toggles and muted workspaces are enforced by
 * the push policy, not here.
 *
 * The text is a deterministic summary computed from the database (no LLM call, so an exhausted
 * workspace quota cannot silence it):
 *   - things waiting on the actor, counted with the same visibility rules as GET /api/for-you
 *     (`loadVisibleForYou`), so the number matches what the app shows;
 *   - agent sessions that completed in the last 24 h.
 * With nothing to say, nothing is sent and nothing is recorded (the next tick looks again, with
 * a short back-off, until the catch-up window closes).
 *
 * Multiple workspaces: ONE briefing per actor per day, anchored to (and deep-linking into) the
 * workspace with the most things waiting (ties: most finished runs, then oldest). Its counts are
 * that workspace's; when the actor belongs to several workspaces the body names it, and counts
 * waiting elsewhere are added as "N more in other workspaces". A combined number with a link to
 * one workspace would not match the screen the tap lands on.
 *
 * Exactly once per local date, across restarts and replicas: the day is claimed with a single
 * conditional `UPDATE ... RETURNING` on `notification_preferences.briefing_last_sent_on`, in the
 * same transaction as the notification insert (a failed insert releases the claim; a concurrent
 * replica blocks on the row lock and then sees the day taken).
 *
 * "Already opened the app today" is NOT used as a skip signal: `device_tokens.last_seen_at` is
 * only written when a client re-registers its token (POST /api/devices), which is not a launch
 * heartbeat, so it would be an invented signal.
 *
 * Killswitch env FEATURE_BRIEFING_PUSH=0 skips the tick (default ON).
 */
import type { Database } from '@maskin/db'
import {
	actors,
	notificationPreferences,
	objects,
	sessions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { loadVisibleForYou } from '../lib/for-you-visibility'
import { localTimeReached } from '../lib/local-time'
import { logger } from '../lib/logger'
import { hasPushDevice, insertPushNotification, resolveSourceActor } from './push-schedule-shared'

const TICK_MS = 60_000
export const KILLSWITCH_ENV_VAR = 'FEATURE_BRIEFING_PUSH'
/** How long after briefing_time a late tick may still send the "morning" briefing. */
export const CATCH_UP_WINDOW_MINUTES = 180
/** An actor with nothing to say is re-checked at most this often within the window. */
const EMPTY_RECHECK_MS = 10 * 60_000
const FINISHED_LOOKBACK_MS = 24 * 60 * 60_000
const BATCH = 500
const MAX_WORKSPACES_PER_ACTOR = 25

export interface BriefingWorkspaceFacts {
	workspaceId: string
	workspaceName: string
	waiting: number
	/** Headline of the first (top-ranked) waiting card. */
	topHeadline: string | null
	finished: number
	/** Set when exactly one run finished: the agent and (if known) the object it worked on. */
	finishedAgentName: string | null
	finishedObjectTitle: string | null
}

export interface BriefingText {
	workspaceId: string
	title: string
	body: string
	waiting: number
	finished: number
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`
}

function clip(text: string, max: number): string {
	const t = text.replace(/\s+/g, ' ').trim()
	return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * Pure: turn per-workspace facts into the briefing, or null when there is nothing to say.
 * `workspaces` must already exclude muted workspaces.
 */
export function buildBriefingText(workspaces: BriefingWorkspaceFacts[]): BriefingText | null {
	const live = workspaces.filter((w) => w.waiting > 0 || w.finished > 0)
	if (live.length === 0) return null
	const anchor = [...live].sort(
		(a, b) =>
			b.waiting - a.waiting ||
			b.finished - a.finished ||
			a.workspaceName.localeCompare(b.workspaceName) ||
			a.workspaceId.localeCompare(b.workspaceId),
	)[0] as BriefingWorkspaceFacts
	const elsewhere = live
		.filter((w) => w.workspaceId !== anchor.workspaceId)
		.reduce((sum, w) => sum + w.waiting, 0)

	let finishedPhrase: string | null = null
	if (anchor.finished === 1 && anchor.finishedAgentName) {
		finishedPhrase = anchor.finishedObjectTitle
			? `${anchor.finishedAgentName} finished '${clip(anchor.finishedObjectTitle, 60)}'`
			: `${anchor.finishedAgentName} finished a task`
	} else if (anchor.finished > 0) {
		finishedPhrase = `${plural(anchor.finished, 'agent run', 'agent runs')} finished`
	}

	const parts: string[] = []
	let title: string
	if (anchor.waiting > 0) {
		title = anchor.waiting === 1 ? '1 thing needs you' : `${anchor.waiting} things need you`
		if (finishedPhrase) parts.push(finishedPhrase)
		else if (anchor.topHeadline) parts.push(clip(anchor.topHeadline, 90))
	} else {
		title = finishedPhrase as string
	}
	const multi = workspaces.length > 1
	if (multi) parts.push(`in ${anchor.workspaceName}`)
	if (elsewhere > 0) parts.push(`${elsewhere} more in other workspaces`)

	return {
		workspaceId: anchor.workspaceId,
		title,
		body: parts.join(' · '),
		waiting: anchor.waiting,
		finished: anchor.finished,
	}
}

type PrefsRow = {
	actorId: string
	timezone: string | null
	briefingTime: number
	briefingLastSentOn: string | null
	mutedWorkspaceIds: string[]
}

export class BriefingPushScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	/** actorId -> epoch ms before which an actor with an empty summary is not re-checked. */
	private emptyUntil = new Map<string, number>()

	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('BriefingPushScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		this.timer.unref?.()
		logger.info('BriefingPushScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection; returns how many briefings this tick sent. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		if (this.env[KILLSWITCH_ENV_VAR] === '0') return 0
		this.running = true
		let sent = 0
		try {
			for (const [id, until] of this.emptyUntil) {
				if (until <= now.getTime()) this.emptyUntil.delete(id)
			}
			let after: string | null = null
			for (;;) {
				const batch: PrefsRow[] = await this.db
					.select({
						actorId: notificationPreferences.actorId,
						timezone: notificationPreferences.timezone,
						briefingTime: notificationPreferences.briefingTime,
						briefingLastSentOn: notificationPreferences.briefingLastSentOn,
						mutedWorkspaceIds: notificationPreferences.mutedWorkspaceIds,
					})
					.from(notificationPreferences)
					.innerJoin(actors, eq(actors.id, notificationPreferences.actorId))
					.where(
						and(
							eq(notificationPreferences.briefingEnabled, true),
							isNotNull(notificationPreferences.timezone),
							eq(actors.type, 'human'),
							hasPushDevice(this.db, notificationPreferences.actorId),
							after ? gt(notificationPreferences.actorId, after) : undefined,
						),
					)
					.orderBy(asc(notificationPreferences.actorId))
					.limit(BATCH)
				for (const row of batch) {
					try {
						if (await this.processActor(row, now)) sent++
					} catch (err) {
						logger.warn('Briefing for actor failed', { actorId: row.actorId, error: String(err) })
					}
				}
				if (batch.length < BATCH) break
				after = (batch[batch.length - 1] as PrefsRow).actorId
			}
		} finally {
			this.running = false
		}
		return sent
	}

	private async processActor(row: PrefsRow, now: Date): Promise<boolean> {
		if (!row.timezone) return false
		const clock = localTimeReached(now, row.timezone, row.briefingTime, CATCH_UP_WINDOW_MINUTES)
		if (!clock) return false // not yet, window over, or an invalid timezone: never guessed
		if (row.briefingLastSentOn && row.briefingLastSentOn >= clock.date) return false
		if ((this.emptyUntil.get(row.actorId) ?? 0) > now.getTime()) return false

		const text = await this.summarize(row, now)
		if (!text) {
			this.emptyUntil.set(row.actorId, now.getTime() + EMPTY_RECHECK_MS)
			return false
		}
		const sourceActorId = await resolveSourceActor(this.db, text.workspaceId, row.actorId)
		if (!sourceActorId) {
			logger.warn('Briefing skipped: workspace has no agent to send it from', {
				actorId: row.actorId,
				workspaceId: text.workspaceId,
			})
			this.emptyUntil.set(row.actorId, now.getTime() + EMPTY_RECHECK_MS)
			return false
		}
		return this.claimAndSend(row, clock.date, text, sourceActorId)
	}

	/**
	 * Claim the local date with one conditional UPDATE, then insert the notification in the same
	 * transaction. Only the caller whose UPDATE returns a row sends.
	 */
	private async claimAndSend(
		row: PrefsRow,
		localDate: string,
		text: BriefingText,
		sourceActorId: string,
	): Promise<boolean> {
		if (!row.timezone) return false
		const timezone = row.timezone
		return this.db.transaction(async (tx) => {
			const claimed = await tx
				.update(notificationPreferences)
				.set({ briefingLastSentOn: localDate })
				.where(
					and(
						eq(notificationPreferences.actorId, row.actorId),
						eq(notificationPreferences.briefingEnabled, true),
						eq(notificationPreferences.timezone, timezone),
						sql`(${notificationPreferences.briefingLastSentOn} IS NULL OR ${notificationPreferences.briefingLastSentOn} < ${localDate}::date)`,
					),
				)
				.returning({ actorId: notificationPreferences.actorId })
			if (claimed.length === 0) return false
			const created = await insertPushNotification(tx, {
				workspaceId: text.workspaceId,
				sourceActorId,
				targetActorId: row.actorId,
				title: text.title,
				body: text.body,
				pushCategory: 'digest',
				collapseKey: `briefing:${localDate}`,
				metadata: {
					kind: 'daily_briefing',
					briefing_date: localDate,
					waiting: text.waiting,
					finished: text.finished,
				},
			})
			return created !== null
		})
	}

	/** Facts for every non-muted workspace the actor belongs to, then the pure text builder. */
	private async summarize(row: PrefsRow, now: Date): Promise<BriefingText | null> {
		const memberships = await this.db
			.select({ id: workspaces.id, name: workspaces.name })
			.from(workspaceMembers)
			.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
			.where(eq(workspaceMembers.actorId, row.actorId))
			.orderBy(asc(workspaces.createdAt), asc(workspaces.id))
			.limit(MAX_WORKSPACES_PER_ACTOR)
		const muted = new Set(row.mutedWorkspaceIds)
		const mine = memberships.filter((w) => !muted.has(w.id))
		if (mine.length === 0) return null

		const since = new Date(now.getTime() - FINISHED_LOOKBACK_MS)
		const finishedRows = await this.db
			.select({
				workspaceId: sessions.workspaceId,
				agentName: actors.name,
				objectTitle: objects.title,
				completedAt: sessions.completedAt,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.leftJoin(objects, eq(objects.id, sessions.initiatedFromObjectId))
			.where(
				and(
					inArray(
						sessions.workspaceId,
						mine.map((w) => w.id),
					),
					eq(sessions.status, 'completed'),
					// Chat turns are conversation, not finished work.
					eq(sessions.interactive, false),
					// Only an agent's own run; a person's session is not "an agent finished".
					eq(actors.type, 'agent'),
					gt(sessions.completedAt, since),
					lte(sessions.completedAt, now),
				),
			)
			.orderBy(asc(sessions.completedAt))
			.limit(500)

		const facts: BriefingWorkspaceFacts[] = []
		for (const w of mine) {
			const visible = await loadVisibleForYou(this.db, w.id, row.actorId)
			const finished = finishedRows.filter((f) => f.workspaceId === w.id)
			const only = finished.length === 1 ? finished[0] : undefined
			facts.push({
				workspaceId: w.id,
				workspaceName: w.name,
				waiting: visible.cards.length,
				topHeadline: visible.cards[0]?.meta.headline ?? null,
				finished: finished.length,
				finishedAgentName: only?.agentName ?? null,
				finishedObjectTitle: only?.objectTitle ?? null,
			})
		}
		return buildBriefingText(facts)
	}
}
