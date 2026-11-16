/**
 * daily-budget-card-scheduler.ts — the morning budget card (daily budget, slice 1a).
 *
 * Ticks about once a minute. For every workspace that has a daily target set, once the
 * workspace's LOCAL clock reaches the start of its day it writes ONE For You card per human
 * owner: yesterday's line, today's bar against the target and the month forecast, all in percent
 * of the plan (`lib/daily-budget-card.ts` builds the words). A workspace whose plan has no limit
 * to take a percent of (unmetered) gets no card.
 *
 * It copies the briefing push's pattern (`briefing-push-scheduler.ts`): one claim per day, no
 * model call, so an exhausted quota cannot silence it. It is a separate notification because the
 * briefing is per person at their own time and anchored to one workspace.
 *
 * Nothing new is stored. The day is claimed by the audit event the insert already writes
 * (`insertNotificationsWithEvents`): under a per-workspace advisory lock the claim looks for a
 * card of this kind already created for the local date. The event outlives a card that someone
 * deleted, so a deleted card is not sent again. The card is `push_category: 'digest'` without
 * `push_force`, so it stays in the app and never buzzes a phone.
 *
 * When work is held for later (see `readHeldWork`), the same card also lists what runs, what
 * waits and what will not fit today, each with an estimate (`estimateSessionCostUsd`, the median
 * of the agent's recent runs on that trigger) or "Estimate unknown". With nothing held the card
 * reads as before.
 *
 * A workspace with no target (the default) gets nothing.
 */
import type { Database } from '@maskin/db'
import { actors, sessions, triggers, workspaceMembers, workspaces } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, asc, desc, eq, gt, gte, lt, sql } from 'drizzle-orm'
import { resolveWorkspaceCapCents } from '../lib/daily-budget'
import {
	type DayTotals,
	PLAN_LIST_LIMIT,
	type PlanItem,
	type TriggerWindowStats,
	buildBudgetCard,
	planDay,
	projectMonth,
	readBudgetSettings,
} from '../lib/daily-budget-card'
import { localClock, localTimeReached } from '../lib/local-time'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
import { SESSION_ADMISSION_ACTION, estimateSessionCostUsd } from './daily-budget-events'
import { resolveSourceActor } from './push-schedule-shared'

const TICK_MS = 60_000
/** A tick that was down at midnight may still send the "morning" card for this long. */
export const CATCH_UP_WINDOW_MINUTES = 180
/** Recent days the forecast averages over. */
export const FORECAST_LOOKBACK_DAYS = 14
/**
 * True while per-trigger totals from "Show what a session cost" have not shipped: the forecast
 * reads stored session cost directly and says so on the card. Flip it when that lands.
 */
export const FORECAST_APPROXIMATE = true
/** Lower sorts first. The card is a report, not an ask, so it sits below the curated asks. */
export const CARD_RANK = 1000
export const CARD_SOURCE = 'daily_budget_card'
const NO_TRIGGER_NAME = 'Not started by a trigger'
const DAY_MS = 24 * 60 * 60_000
const BATCH = 200
/** How far back a deferral is looked for. Held work does not wait longer than the next day. */
const HELD_LOOKBACK_DAYS = 3
/** Normal work starts before low work; urgent work is never held, but sorts first if it is. */
const IMPORTANCE_ORDER = sql`CASE e.data->>'priority' WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`

interface WorkItem {
	actorId: string
	triggerId: string | null
	title: string
}

type WorkspaceRow = {
	id: string
	settings: unknown
	enterpriseGranted: boolean | null
	billingOwnerId: string | null
}

/** First instant of the local calendar day that `at` falls on, in `timezone`. */
export function startOfLocalDay(at: Date, timezone: string): Date | null {
	const clock = localClock(at, timezone)
	if (!clock) return null
	let guess = new Date(at.getTime() - clock.minute * 60_000)
	// A DST change between midnight and `at` shifts the guess by an hour; walk it back.
	for (let i = 0; i < 3; i++) {
		const c = localClock(guess, timezone)
		if (!c) return null
		if (c.date === clock.date && c.minute === 0) return guess
		guess =
			c.date === clock.date
				? new Date(guess.getTime() - c.minute * 60_000)
				: new Date(guess.getTime() + (24 * 60 - c.minute) * 60_000)
	}
	return guess
}

/** Days in the calendar month of a `YYYY-MM-DD` local date. */
export function daysInMonthOf(localDate: string): number {
	const [y, m] = localDate.split('-').map(Number)
	return new Date(Date.UTC(y as number, m as number, 0)).getUTCDate()
}

/**
 * Per trigger: runs started in [from, to), how many carry a cost, and what they cost as a
 * percent of the plan (cost in USD cents over the plan limit `capCents`). The one place that
 * turns session cost into "today against target"; the card and the gate on new work both read it.
 */
export async function readWindowStats(
	db: Database,
	workspaceId: string,
	capCents: number,
	from: Date,
	to: Date,
): Promise<TriggerWindowStats[]> {
	const spend = sql`(COALESCE(${sessions.totalCostUsd}, 0)::float8 * 10000.0 / ${capCents})`
	const rows = await db
		.select({
			triggerId: sessions.triggerId,
			name: triggers.name,
			runs: sql<number>`count(*)::int`,
			knownRuns: sql<number>`(count(*) FILTER (WHERE ${spend} > 0))::int`,
			spent: sql<number>`COALESCE(sum(${spend}) FILTER (WHERE ${spend} > 0), 0)::float8`,
		})
		.from(sessions)
		.leftJoin(triggers, eq(triggers.id, sessions.triggerId))
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				gte(sessions.createdAt, from),
				lt(sessions.createdAt, to),
			),
		)
		.groupBy(sessions.triggerId, triggers.name)
	return rows.map((r) => ({
		triggerId: r.triggerId,
		name: r.name ?? NO_TRIGGER_NAME,
		runs: r.runs,
		knownRuns: r.knownRuns,
		spent: r.spent,
	}))
}

export class DailyBudgetCardScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	/** workspaceId -> local date already handled, so a minute tick does not re-query all day. */
	private handled = new Map<string, string>()

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('DailyBudgetCardScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		this.timer.unref?.()
		logger.info('DailyBudgetCardScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection; returns how many workspaces got a card this tick. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		let sent = 0
		try {
			let after: string | null = null
			for (;;) {
				const batch: Array<WorkspaceRow> = await this.db
					.select({
						id: workspaces.id,
						settings: workspaces.settings,
						enterpriseGranted: workspaces.enterpriseGranted,
						billingOwnerId: workspaces.billingOwnerId,
					})
					.from(workspaces)
					.where(
						and(
							sql`${workspaces.settings} ? 'daily_budget'`,
							after ? gt(workspaces.id, after) : undefined,
						),
					)
					.orderBy(asc(workspaces.id))
					.limit(BATCH)
				for (const ws of batch) {
					try {
						if (await this.processWorkspace(ws, now)) sent++
					} catch (err) {
						logger.warn('Daily budget card failed', { workspaceId: ws.id, error: String(err) })
					}
				}
				if (batch.length < BATCH) break
				after = (batch[batch.length - 1] as { id: string }).id
			}
		} finally {
			this.running = false
		}
		return sent
	}

	private async processWorkspace(ws: WorkspaceRow, now: Date): Promise<boolean> {
		const workspaceId = ws.id
		const capCents = resolveWorkspaceCapCents(ws)
		if (capCents === null) return false // unmetered plan: no limit to take a percent of
		const cfg = readBudgetSettings(ws.settings, capCents)
		if (!cfg) return false
		const clock = localTimeReached(now, cfg.timezone, 0, CATCH_UP_WINDOW_MINUTES)
		if (!clock) return false // not the start of the day yet, window over, or a bad timezone
		if (this.handled.get(workspaceId) === clock.date) return false

		const todayStart = startOfLocalDay(now, cfg.timezone)
		const yesterdayStart =
			todayStart && startOfLocalDay(new Date(todayStart.getTime() - 60_000), cfg.timezone)
		if (!todayStart || !yesterdayStart) return false

		const [yesterday, today, forecastStats] = await Promise.all([
			this.windowStats(workspaceId, capCents, yesterdayStart, todayStart),
			this.windowStats(workspaceId, capCents, todayStart, now),
			this.windowStats(
				workspaceId,
				capCents,
				new Date(todayStart.getTime() - FORECAST_LOOKBACK_DAYS * DAY_MS),
				todayStart,
			),
		])
		const todayTotals = totalsOf(today)
		const yesterdayTotals = totalsOf(yesterday)
		const stopAt = (cfg.target.amount * cfg.stopShare) / 100
		const dayPlan = await this.readDayPlan(workspaceId, capCents, now, {
			spentToday: todayTotals.spent,
			stopAt,
			stoppedYesterday: yesterdayTotals.spent >= stopAt,
		})
		const card = buildBudgetCard({
			target: cfg.target,
			yesterday: yesterdayTotals,
			today: todayTotals,
			forecast: projectMonth(
				forecastStats,
				cfg.target,
				FORECAST_LOOKBACK_DAYS,
				daysInMonthOf(clock.date),
			),
			approximate: FORECAST_APPROXIMATE,
			note: cfg.note ?? undefined,
			plan: dayPlan,
		})

		const sent = await this.claimAndSend(workspaceId, clock.date, card)
		this.handled.set(workspaceId, clock.date)
		return sent
	}

	private windowStats(
		workspaceId: string,
		capCents: number,
		from: Date,
		to: Date,
	): Promise<TriggerWindowStats[]> {
		return readWindowStats(this.db, workspaceId, capCents, from, to)
	}

	/**
	 * Work held for later, in the order it will start: sessions a deferral was recorded for
	 * (`session_admission`, decision deferred) that are still waiting to start. Once a held session
	 * starts it leaves 'starting', so it drops out of this read by itself. Most important first,
	 * oldest first within one level.
	 */
	async readHeldWork(workspaceId: string, now: Date): Promise<WorkItem[]> {
		const since = new Date(now.getTime() - HELD_LOOKBACK_DAYS * DAY_MS)
		const rows = await this.db.execute<{
			actor_id: string
			trigger_id: string | null
			agent: string
			trigger_name: string | null
		}>(sql`
			SELECT s.actor_id, s.trigger_id, a.name AS agent, t.name AS trigger_name
			FROM events e
			JOIN sessions s ON s.id = e.entity_id
			JOIN actors a ON a.id = s.actor_id
			LEFT JOIN triggers t ON t.id = s.trigger_id
			WHERE e.workspace_id = ${workspaceId}
				AND e.action = ${SESSION_ADMISSION_ACTION}
				AND e.entity_type = 'session'
				AND e.created_at >= ${since.toISOString()}::timestamptz
				AND e.data->>'decision' = 'deferred'
				AND s.status = 'starting'
				AND s.started_at IS NULL
			ORDER BY ${IMPORTANCE_ORDER}, s.created_at ASC`)
		return rows.map((r) => ({
			actorId: r.actor_id,
			triggerId: r.trigger_id,
			title: r.trigger_name ? `${r.agent}, ${r.trigger_name}` : r.agent,
		}))
	}

	/** Sessions running right now: urgent work keeps going while the rest waits. */
	private async readRunningWork(workspaceId: string): Promise<WorkItem[]> {
		const rows = await this.db
			.select({
				actorId: sessions.actorId,
				triggerId: sessions.triggerId,
				agent: actors.name,
				triggerName: triggers.name,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.actorId))
			.leftJoin(triggers, eq(triggers.id, sessions.triggerId))
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'running')))
			.orderBy(desc(sessions.createdAt))
			.limit(PLAN_LIST_LIMIT * 2)
		return rows.map((r) => ({
			actorId: r.actorId,
			triggerId: r.triggerId,
			title: r.triggerName ? `${r.agent}, ${r.triggerName}` : r.agent,
		}))
	}

	/** One estimate per agent and trigger, as a percent of the plan; null is "Estimate unknown". */
	private async estimateItems(
		workspaceId: string,
		capCents: number,
		items: WorkItem[],
	): Promise<PlanItem[]> {
		const seen = new Map<string, Promise<number | null>>()
		return Promise.all(
			items.map(async (item) => {
				const key = `${item.actorId}:${item.triggerId ?? ''}`
				let usd = seen.get(key)
				if (!usd) {
					usd = estimateSessionCostUsd(this.db, {
						workspaceId,
						actorId: item.actorId,
						triggerId: item.triggerId,
					}).catch(() => null)
					seen.set(key, usd)
				}
				const cost = await usd
				return {
					title: item.title,
					estimate: cost === null ? null : (cost * 10000) / capCents,
				}
			}),
		)
	}

	/** The three lists for the card, or undefined when nothing is held. */
	private async readDayPlan(
		workspaceId: string,
		capCents: number,
		now: Date,
		day: { spentToday: number; stopAt: number; stoppedYesterday: boolean },
	) {
		const held = await this.readHeldWork(workspaceId, now)
		if (held.length === 0) return undefined
		const running = await this.readRunningWork(workspaceId)
		const [heldItems, runningItems] = await Promise.all([
			this.estimateItems(workspaceId, capCents, held),
			this.estimateItems(workspaceId, capCents, running),
		])
		return planDay({ running: runningItems, held: heldItems, ...day })
	}

	/**
	 * One card per human owner for this local date, or none when the date was already claimed.
	 * The lock serialises replicas; the check reads the audit events of cards already created.
	 */
	private async claimAndSend(
		workspaceId: string,
		localDate: string,
		card: { headline: string; rationale: string },
	): Promise<boolean> {
		const owners = await this.db
			.select({ id: actors.id })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.role, 'owner'),
					eq(actors.type, 'human'),
				),
			)
			.orderBy(asc(actors.id))
		const targets: Array<{ ownerId: string; sourceActorId: string }> = []
		for (const owner of owners) {
			const sourceActorId = await resolveSourceActor(this.db, workspaceId, owner.id)
			if (sourceActorId) targets.push({ ownerId: owner.id, sourceActorId })
		}
		if (targets.length === 0) {
			logger.warn('Daily budget card skipped: no owner, or no agent to send it from', {
				workspaceId,
			})
			return false
		}

		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`${CARD_SOURCE}:${workspaceId}`}))`,
			)
			const taken = await tx.execute(sql`
				SELECT 1 FROM events
				WHERE workspace_id = ${workspaceId}
					AND created_at > now() - interval '2 days'
					AND entity_type = 'notification'
					AND action = 'created'
					AND data->'metadata'->>'source' = ${CARD_SOURCE}
					AND data->'metadata'->>'budget_date' = ${localDate}
				LIMIT 1`)
			if (taken.length > 0) return false

			let created = 0
			for (const { ownerId, sourceActorId } of targets) {
				const rows = await insertNotificationsWithEvents(tx, {
					workspaceId,
					actorId: sourceActorId,
					rows: [
						{
							workspaceId,
							type: 'needs_input',
							title: card.headline,
							content: card.rationale,
							sourceActorId,
							targetActorId: ownerId,
							status: 'pending',
							metadata: {
								kind: FOR_YOU_KIND,
								rank: CARD_RANK,
								headline: card.headline,
								rationale: card.rationale,
								source: CARD_SOURCE,
								budget_date: localDate,
								push_category: 'digest',
							},
						},
					],
				})
				created += rows.length
			}
			return created > 0
		})
	}
}

export function totalsOf(stats: TriggerWindowStats[]): DayTotals {
	return stats.reduce(
		(t, s) => ({
			runs: t.runs + s.runs,
			knownRuns: t.knownRuns + s.knownRuns,
			spent: t.spent + s.spent,
		}),
		{ runs: 0, knownRuns: 0, spent: 0 },
	)
}
