/**
 * daily-budget-events.ts — the two events the daily token budget is judged from.
 * Spec: sections 5 and 7a of the "daily token budget" bet. Reporting only: nothing here gates,
 * queues or defers a session.
 *
 *   session_admission     One per session started through startSession(). Carries the decision
 *                         (admitted, deferred or blocked), a priority and an estimated cost. In 1a
 *                         every decision is "admitted"; the rows are the baseline 1b is judged
 *                         against. Not covered: resumeSession() (an existing row is re-driven, not
 *                         started), the two direct createSession() callers (workspaces.ts onboarding
 *                         kickoff, desktop-teach.ts) and voice calls (voice_sessions rows, not
 *                         sessions rows).
 *
 *   daily_budget_summary  One per workspace per day, written by DailyBudgetSummaryScheduler once
 *                         the day has ended. `data.day` is the day it summarises. No model call.
 *                         The day is claimed under an advisory lock so replicas and restarts
 *                         write it once.
 *
 * Both are rows in `events`, so they are readable by SQL today while product analytics ingestion is
 * dark. Writing an event must never stop a session from starting or the scheduler from running, so
 * every writer here swallows and logs its own failure.
 */
import type { Database } from '@maskin/db'
import { events, sessions, workspaces } from '@maskin/db/schema'
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { resolveSourceActor } from './push-schedule-shared'

export const SESSION_ADMISSION_ACTION = 'session_admission'
export const DAILY_BUDGET_SUMMARY_ACTION = 'daily_budget_summary'

export type AdmissionDecision = 'admitted' | 'deferred' | 'blocked'
/** Placeholder scale for 1a: human-facing work is urgent, everything else is normal. 1b owns the real one. */
export type AdmissionPriority = 'urgent' | 'normal'

/** How many recent completed runs of the same agent and trigger the cost estimate looks at. */
const ESTIMATE_SAMPLE = 20

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const DAY_MS = 24 * 60 * 60 * 1000
const TICK_MS = 10 * 60 * 1000

export function median(values: number[]): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) return sorted[mid] as number
	return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Trailing median cost of the agent's last completed runs on this trigger, or null ("Estimate unknown"). */
export async function estimateSessionCostUsd(
	db: Database,
	params: { workspaceId: string; actorId: string; triggerId: string | null },
): Promise<number | null> {
	const rows = await db
		.select({ cost: sessions.totalCostUsd })
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, params.workspaceId),
				eq(sessions.actorId, params.actorId),
				params.triggerId ? eq(sessions.triggerId, params.triggerId) : isNull(sessions.triggerId),
				eq(sessions.status, 'completed'),
				sql`${sessions.totalCostUsd} > 0`,
			),
		)
		.orderBy(desc(sessions.completedAt))
		.limit(ESTIMATE_SAMPLE)
	return median(rows.map((r) => Number(r.cost)))
}

export interface AdmissionInput {
	sessionId: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	callerKind: string
	humanFacing: boolean
}

/** Writes the admission event for a freshly started session. Never throws. */
export async function recordSessionAdmission(db: Database, input: AdmissionInput): Promise<void> {
	try {
		const estimatedCostUsd = await estimateSessionCostUsd(db, input).catch((err) => {
			logger.warn('Admission cost estimate failed', {
				sessionId: input.sessionId,
				error: String(err),
			})
			return null
		})
		const decision: AdmissionDecision = 'admitted'
		const priority: AdmissionPriority = input.humanFacing ? 'urgent' : 'normal'
		await recordEvent(db, {
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			action: SESSION_ADMISSION_ACTION,
			entityType: 'session',
			entityId: input.sessionId,
			data: {
				decision,
				priority,
				estimated_cost_usd: estimatedCostUsd,
				caller_kind: input.callerKind,
				trigger_id: input.triggerId,
			},
		})
	} catch (err) {
		logger.warn('Failed to write session_admission event', {
			sessionId: input.sessionId,
			error: String(err),
		})
	}
}

// ── Daily summary ──────────────────────────────────────────────────────────

/** A valid IANA timezone, or UTC. */
function safeTimezone(timezone: unknown): string {
	if (typeof timezone !== 'string' || timezone === '') return 'UTC'
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone })
		return timezone
	} catch {
		return 'UTC'
	}
}

/** `YYYY-MM-DD` of the day containing `at` in `timezone`. */
export function localDay(at: Date, timezone: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(at)
}

/** `YYYY-MM-DD` of the day before `at`, in `timezone`. */
export function previousLocalDay(at: Date, timezone: string): string {
	return shiftDay(localDay(at, timezone), -1)
}

function shiftDay(day: string, by: number): string {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number]
	return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10)
}

/** How far `timezone` is ahead of UTC at `at`, in ms. */
function offsetMs(at: Date, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	}).formatToParts(at)
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour'),
		get('minute'),
		get('second'),
	)
	return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant a local day starts in `timezone` (its midnight). */
export function localDayStart(day: string, timezone: string): Date {
	const guess = new Date(`${day}T00:00:00.000Z`)
	const first = new Date(guess.getTime() - offsetMs(guess, timezone))
	// The offset can differ at the real midnight (a clock change in between), so settle once more.
	return new Date(guess.getTime() - offsetMs(first, timezone))
}

interface DailyTarget {
	unit: 'tokens' | 'dollars'
	amount: number
	timezone: string
}

/**
 * The owner's daily target, if one is set: workspace settings key `daily_budget`, written by the
 * target setting (unit tokens or dollars, amount, stop_share, IANA timezone, UTC when absent).
 */
export function readDailyTarget(settings: unknown): DailyTarget | null {
	const raw = (
		settings as { daily_budget?: { unit?: unknown; amount?: unknown; timezone?: unknown } } | null
	)?.daily_budget
	if (!raw) return null
	if (raw.unit !== 'tokens' && raw.unit !== 'dollars') return null
	if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) return null
	return { unit: raw.unit, amount: raw.amount, timezone: safeTimezone(raw.timezone) }
}

/** The timezone a workspace's day runs in: its target's, UTC when there is none. */
function workspaceTimezone(settings: unknown): string {
	return readDailyTarget(settings)?.timezone ?? 'UTC'
}

/**
 * Writes the summary of the local `day` (in the workspace's own timezone) unless one already exists.
 * Writes nothing for a workspace with no target and no finished run that day. Returns true when this
 * call wrote it. Runs in one transaction under an advisory lock keyed on workspace and day, so a concurrent
 * replica waits, then sees the row and stops.
 */
export async function writeDailySummary(
	db: Database,
	workspaceId: string,
	day: string,
): Promise<boolean> {
	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) return false
	const timezone = workspaceTimezone(ws.settings)
	const dayStart = localDayStart(day, timezone)
	const dayEnd = localDayStart(shiftDay(day, 1), timezone)
	const actorId = await resolveSourceActor(db, workspaceId, NIL_UUID)
	if (!actorId) return false

	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${DAILY_BUDGET_SUMMARY_ACTION}:${workspaceId}:${day}`}, 0))`,
		)
		const [existing] = await tx
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, DAILY_BUDGET_SUMMARY_ACTION),
					sql`${events.data}->>'day' = ${day}`,
				),
			)
			.limit(1)
		if (existing) return false

		// Spend is attributed to the day a run completed: cost is only written when a run ends.
		const [spend] = await tx
			.select({
				costUsd: sql<string>`coalesce(sum(${sessions.totalCostUsd}), 0)`,
				inputTokens: sql<string>`coalesce(sum(${sessions.inputTokens}), 0)`,
				outputTokens: sql<string>`coalesce(sum(${sessions.outputTokens}), 0)`,
				cacheCreationTokens: sql<string>`coalesce(sum(${sessions.cacheCreationInputTokens}), 0)`,
				cacheReadTokens: sql<string>`coalesce(sum(${sessions.cacheReadInputTokens}), 0)`,
				sessions: sql<string>`count(*)`,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					gte(sessions.completedAt, dayStart),
					lt(sessions.completedAt, dayEnd),
				),
			)
		const [deferred] = await tx
			.select({ n: sql<string>`count(*)` })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.action, SESSION_ADMISSION_ACTION),
					sql`${events.data}->>'decision' = 'deferred'`,
					gte(events.createdAt, dayStart),
					lt(events.createdAt, dayEnd),
				),
			)

		const costUsd = Number(spend?.costUsd ?? 0)
		const input = Number(spend?.inputTokens ?? 0)
		const output = Number(spend?.outputTokens ?? 0)
		const cacheCreation = Number(spend?.cacheCreationTokens ?? 0)
		const cacheRead = Number(spend?.cacheReadTokens ?? 0)
		// ASSUMED token unit: input + output + cache writes. Cache reads are listed apart.
		const tokens = input + output + cacheCreation
		const target = readDailyTarget(ws.settings)
		if (!target && Number(spend?.sessions ?? 0) === 0) return false

		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: DAILY_BUDGET_SUMMARY_ACTION,
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				day,
				target: target?.amount ?? null,
				unit: target?.unit ?? null,
				timezone: target?.timezone ?? 'UTC',
				spent: target?.unit === 'dollars' ? costUsd : target?.unit === 'tokens' ? tokens : null,
				deferred: Number(deferred?.n ?? 0),
				spent_usd: costUsd,
				spent_tokens: tokens,
				cache_read_tokens: cacheRead,
				sessions: Number(spend?.sessions ?? 0),
			},
		})
		return true
	})
}

/**
 * Writes the summary of each workspace's last finished local day, once that workspace's own midnight
 * has passed. Ticks every ten minutes; a workspace is looked at again only when its day changes, and
 * the per-workspace claim makes a repeat harmless.
 */
export class DailyBudgetSummaryScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	/** workspace id -> the last day this process already settled for it. */
	private settledDay = new Map<string, string>()

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('DailyBudgetSummaryScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		this.timer.unref?.()
		logger.info('DailyBudgetSummaryScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection; returns how many summaries this tick wrote. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		let written = 0
		try {
			// A workspace's last finished day ended at most 48 hours ago in any timezone, so recent
			// activity is enough to find every workspace that could have something to summarise.
			const since = new Date(now.getTime() - 2 * DAY_MS)
			const active = await this.db
				.selectDistinct({ workspaceId: sessions.workspaceId })
				.from(sessions)
				.where(or(gte(sessions.completedAt, since), gte(sessions.createdAt, since)))
			const withTarget = await this.db
				.select({ workspaceId: workspaces.id })
				.from(workspaces)
				.where(sql`${workspaces.settings}->'daily_budget' is not null`)
			const ids = [...new Set([...active, ...withTarget].map((r) => r.workspaceId))]
			if (ids.length === 0) return 0
			const rows = await this.db
				.select({ id: workspaces.id, settings: workspaces.settings })
				.from(workspaces)
				.where(inArray(workspaces.id, ids))
			for (const ws of rows) {
				const day = previousLocalDay(now, workspaceTimezone(ws.settings))
				if (this.settledDay.get(ws.id) === day) continue
				try {
					if (await writeDailySummary(this.db, ws.id, day)) written++
					this.settledDay.set(ws.id, day)
				} catch (err) {
					logger.warn('Daily budget summary failed', {
						workspaceId: ws.id,
						day,
						error: String(err),
					})
				}
			}
		} finally {
			this.running = false
		}
		return written
	}
}
