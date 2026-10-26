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
import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
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

/** `YYYY-MM-DD` of the UTC day containing `at`. ASSUMED day boundary: UTC, there is no workspace timezone yet. */
export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10)
}

export function previousUtcDay(at: Date): string {
	return utcDay(new Date(at.getTime() - DAY_MS))
}

interface DailyTarget {
	unit: 'tokens' | 'usd'
	amount: number
}

/**
 * The owner's daily target, if one is set. ASSUMED storage (spec section 8): workspace settings key
 * `daily_budget` with `unit` and `amount`. Null until the target setting ships.
 */
export function readDailyTarget(settings: unknown): DailyTarget | null {
	const raw = (settings as { daily_budget?: { unit?: unknown; amount?: unknown } } | null)
		?.daily_budget
	if (!raw) return null
	if (raw.unit !== 'tokens' && raw.unit !== 'usd') return null
	if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) return null
	return { unit: raw.unit, amount: raw.amount }
}

/**
 * Writes the summary of `day` for the workspace unless one already exists. Returns true when this call
 * wrote it. Runs in one transaction under an advisory lock keyed on workspace and day, so a concurrent
 * replica waits, then sees the row and stops.
 */
export async function writeDailySummary(
	db: Database,
	workspaceId: string,
	day: string,
): Promise<boolean> {
	const dayStart = new Date(`${day}T00:00:00.000Z`)
	const dayEnd = new Date(dayStart.getTime() + DAY_MS)

	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) return false
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
				spent: target?.unit === 'usd' ? costUsd : target?.unit === 'tokens' ? tokens : null,
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
 * Writes yesterday's summary for every workspace that ran something yesterday or has a target.
 * Ticks every ten minutes but only scans once a day; the per-workspace claim makes a repeat harmless.
 */
export class DailyBudgetSummaryScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private scannedDay: string | null = null

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
		const today = utcDay(now)
		if (this.running || this.scannedDay === today) return 0
		this.running = true
		let written = 0
		let failed = false
		try {
			const day = previousUtcDay(now)
			const dayStart = new Date(`${day}T00:00:00.000Z`)
			const dayEnd = new Date(dayStart.getTime() + DAY_MS)
			const active = await this.db
				.selectDistinct({ workspaceId: sessions.workspaceId })
				.from(sessions)
				.where(
					or(
						and(gte(sessions.completedAt, dayStart), lt(sessions.completedAt, dayEnd)),
						and(gte(sessions.createdAt, dayStart), lt(sessions.createdAt, dayEnd)),
					),
				)
			const withTarget = await this.db
				.select({ workspaceId: workspaces.id })
				.from(workspaces)
				.where(sql`${workspaces.settings}->'daily_budget' is not null`)
			const ids = new Set([...active, ...withTarget].map((r) => r.workspaceId))
			for (const workspaceId of ids) {
				try {
					if (await writeDailySummary(this.db, workspaceId, day)) written++
				} catch (err) {
					failed = true
					logger.warn('Daily budget summary failed', { workspaceId, day, error: String(err) })
				}
			}
			if (!failed) this.scannedDay = today
		} finally {
			this.running = false
		}
		return written
	}
}
