/**
 * workspace-usage-snapshot.ts: one `workspace_usage_snapshot` PostHog event per workspace per UTC
 * day, so we can watch our heaviest workspaces. Never shown to customers.
 *
 * Percent, dollars and the plan limit come from the same code the usage page runs
 * (`resolveBillingWindow`, `getWorkspacePlanUsdCentsUsage`, `usagePercent`), and the tokens from the
 * same session rows (`getWorkspacePlanTokenUsage`), so the figures always agree with the app.
 *
 * Who is sent: a workspace with plan usage in its current period, on a metered plan. Enterprise is
 * not metered. A workspace that switched share usage off sends nothing, because the event goes
 * through `capturePosthogEvent` like every other (it follows the workspace privacy setting).
 *
 * Once a day per workspace, however many replicas or restarts: the day is claimed with an
 * `events` row under an advisory lock, as `daily-budget-events.ts` does for its summary. The row
 * holds the same figures, so the day can also be read with SQL. A send that failed (PostHog
 * refused it or was unreachable) gives its claim back, so the next tick tries again; one that was
 * skipped on purpose (share usage off, no API key) keeps it, since a retry would skip again.
 *
 * Reads are grouped: one read of the workspaces, one of today's claims, two of plan usage (sessions
 * and spend) and one of claim actors cover every candidate, not a handful of queries each.
 */
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	sessions,
	workspaceAiUsage,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { usagePercent } from '@maskin/shared'
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { recordEventReturning } from '../lib/events/record-event'
import { getPlanUsageForWorkspaces } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { resolveBillingWindow } from '../routes/billing'

export const WORKSPACE_USAGE_SNAPSHOT_EVENT = 'workspace_usage_snapshot'

const DAY_MS = 24 * 60 * 60 * 1000
const TICK_MS = 30 * 60 * 1000
const BOOT_DELAY_MS = 2 * 60 * 1000
// The longest billing period is a month, so a workspace with usage in its current period has
// session or spend rows from the last 35 days. The exact period is checked per workspace.
const CANDIDATE_WINDOW_MS = 35 * DAY_MS

export interface UsageSnapshot {
	workspace_id: string
	plan: string
	/** Unix seconds, as the usage page reports it; null when the plan has no stored period. */
	period_start: number | null
	/** Whole percent of the plan limit, 0 to 100, as the app shows it. Null when no limit is known. */
	usage_percent: number | null
	usd_cents_used: number
	/** Null when the plan has no cap, as on the usage page. */
	plan_limit_usd_cents: number | null
	input_tokens: number
	output_tokens: number
	session_count: number
}

/**
 * The snapshots of these workspaces, keyed by workspace id. A workspace is left out when there is
 * nothing to send: it is gone, is not metered (enterprise), or has no plan usage in its current
 * period.
 */
export async function readUsageSnapshots(
	db: Pick<Database, 'select'>,
	workspaceIds: string[],
): Promise<Map<string, UsageSnapshot>> {
	const out = new Map<string, UsageSnapshot>()
	if (workspaceIds.length === 0) return out
	const rows = await db
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(inArray(workspaces.id, workspaceIds))

	const metered = rows
		.map((workspace) => ({ id: workspace.id, window: resolveBillingWindow(workspace) }))
		.filter((w) => w.window.plan !== 'enterprise')
	const usage = await getPlanUsageForWorkspaces(
		db,
		metered.map((w) => ({ workspaceId: w.id, periodStartMs: w.window.periodStartMs })),
	)
	for (const { id, window } of metered) {
		const used = usage.get(id)
		if (!used || (used.usdCents === 0 && used.sessionCount === 0)) continue
		out.set(id, {
			workspace_id: id,
			plan: window.plan,
			period_start: window.periodStartSec,
			usage_percent: usagePercent(used.usdCents, window.hardCapCents),
			usd_cents_used: used.usdCents,
			plan_limit_usd_cents: window.hardCapCents,
			input_tokens: used.inputTokens,
			output_tokens: used.outputTokens,
			session_count: used.sessionCount,
		})
	}
	return out
}

/** The snapshot of one workspace, or null when there is nothing to send. */
export async function readUsageSnapshot(
	db: Pick<Database, 'select'>,
	workspaceId: string,
): Promise<UsageSnapshot | null> {
	return (await readUsageSnapshots(db, [workspaceId])).get(workspaceId) ?? null
}

const claimMatch = (workspaceId: string, day: string) =>
	and(
		eq(events.workspaceId, workspaceId),
		eq(events.entityId, workspaceId),
		eq(events.action, WORKSPACE_USAGE_SNAPSHOT_EVENT),
		sql`${events.data}->>'day' = ${day}`,
	)

/** Which of these workspaces already have today's claim, in one read. */
async function claimedWorkspaces(
	db: Pick<Database, 'select'>,
	workspaceIds: string[],
	day: string,
): Promise<Set<string>> {
	if (workspaceIds.length === 0) return new Set()
	const rows = await db
		.select({ workspaceId: events.workspaceId })
		.from(events)
		.where(
			and(
				inArray(events.workspaceId, workspaceIds),
				eq(events.action, WORKSPACE_USAGE_SNAPSHOT_EVENT),
				sql`${events.data}->>'day' = ${day}`,
			),
		)
	return new Set(rows.map((r) => r.workspaceId))
}

/**
 * The actor each claim row is written as, one per workspace, in one read: the first non-human
 * member by the same order `resolveSourceActor` uses. A workspace with none has no entry.
 */
async function claimActors(
	db: Pick<Database, 'selectDistinctOn'>,
	workspaceIds: string[],
): Promise<Map<string, string>> {
	if (workspaceIds.length === 0) return new Map()
	const rows = await db
		.selectDistinctOn([workspaceMembers.workspaceId], {
			workspaceId: workspaceMembers.workspaceId,
			actorId: actors.id,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(inArray(workspaceMembers.workspaceId, workspaceIds), ne(actors.type, 'human')))
		.orderBy(
			workspaceMembers.workspaceId,
			desc(sql`${actors.name} = 'Chief of Staff'`),
			desc(actors.isSystem),
			asc(actors.createdAt),
			asc(actors.id),
		)
	return new Map(rows.map((r) => [r.workspaceId, r.actorId]))
}

export interface SnapshotRun {
	/** Workspaces whose snapshot this call sent. */
	sent: string[]
	/** Workspaces that need no more tries today: sent, skipped on purpose, or claimed by someone else. */
	settled: string[]
}

/**
 * Sends the snapshot of each workspace for the UTC `day` unless one was already claimed.
 *
 * The claim is committed before the send, so two replicas cannot both send. When the send then
 * fails, the claim is deleted again so the next tick retries; a send skipped on purpose (share
 * usage off) keeps it.
 */
export async function sendUsageSnapshots(
	db: Database,
	workspaceIds: string[],
	day: string,
): Promise<SnapshotRun> {
	const run: SnapshotRun = { sent: [], settled: [] }
	const claimed = await claimedWorkspaces(db, workspaceIds, day)
	run.settled.push(...claimed)

	const todo = workspaceIds.filter((id) => !claimed.has(id))
	const snapshots = await readUsageSnapshots(db, todo)
	const actorIds = await claimActors(db, [...snapshots.keys()])

	for (const [workspaceId, snapshot] of snapshots) {
		try {
			const actorId = actorIds.get(workspaceId)
			if (!actorId) continue

			const claim = await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${`${WORKSPACE_USAGE_SNAPSHOT_EVENT}:${workspaceId}:${day}`}, 0))`,
				)
				const [existing] = await tx
					.select({ id: events.id })
					.from(events)
					.where(claimMatch(workspaceId, day))
					.limit(1)
				if (existing) return null
				return recordEventReturning(tx, {
					workspaceId,
					actorId,
					action: WORKSPACE_USAGE_SNAPSHOT_EVENT,
					entityType: 'workspace',
					entityId: workspaceId,
					data: { day, ...snapshot },
				})
			})
			if (!claim) {
				run.settled.push(workspaceId)
				continue
			}

			const result = await capturePosthogEvent(WORKSPACE_USAGE_SNAPSHOT_EVENT, workspaceId, {
				...snapshot,
			})
			if (result === 'failed') {
				// Give the day back so the next tick sends it.
				await db
					.delete(events)
					.where(eq(events.id, claim.id))
					.catch((err) =>
						logger.warn('Workspace usage snapshot claim not released', {
							workspaceId,
							day,
							error: String(err),
						}),
					)
				continue
			}
			run.settled.push(workspaceId)
			if (result === 'sent') run.sent.push(workspaceId)
		} catch (err) {
			logger.warn('Workspace usage snapshot failed', { workspaceId, day, error: String(err) })
		}
	}
	return run
}

/** One workspace. True when this call sent the snapshot for the day. */
export async function sendUsageSnapshot(
	db: Database,
	workspaceId: string,
	day: string,
): Promise<boolean> {
	return (await sendUsageSnapshots(db, [workspaceId], day)).sent.includes(workspaceId)
}

/**
 * Ticks every 30 minutes and sends each active workspace's snapshot once per UTC day. A workspace
 * that is settled for the day is remembered in memory, so only a restart looks its claim up again.
 * One that has nothing to send yet, or whose send failed, is looked at again on the next tick.
 */
export class WorkspaceUsageSnapshotScheduler {
	private timer: NodeJS.Timeout | null = null
	private bootTimer: NodeJS.Timeout | null = null
	private running = false
	/** workspace id -> the last day this process already settled for it. */
	private settledDay = new Map<string, string>()

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.run(), TICK_MS)
		this.timer.unref?.()
		this.bootTimer = setTimeout(() => this.run(), BOOT_DELAY_MS)
		this.bootTimer.unref?.()
		logger.info('WorkspaceUsageSnapshotScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.bootTimer) {
			clearTimeout(this.bootTimer)
			this.bootTimer = null
		}
	}

	private run(): void {
		this.tick().catch((err) =>
			logger.error('WorkspaceUsageSnapshotScheduler tick failed', { error: String(err) }),
		)
	}

	/** Public for test injection; returns how many snapshots this tick sent. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const day = now.toISOString().slice(0, 10)
			const since = new Date(now.getTime() - CANDIDATE_WINDOW_MS)
			const [fromSessions, fromSpend] = await Promise.all([
				this.db
					.selectDistinct({ workspaceId: sessions.workspaceId })
					.from(sessions)
					.where(gte(sessions.createdAt, since)),
				this.db
					.selectDistinct({ workspaceId: workspaceAiUsage.workspaceId })
					.from(workspaceAiUsage)
					.where(gte(workspaceAiUsage.createdAt, since)),
			])
			const ids = [...new Set([...fromSessions, ...fromSpend].map((r) => r.workspaceId))].filter(
				(id) => this.settledDay.get(id) !== day,
			)
			if (ids.length === 0) return 0
			try {
				const run = await sendUsageSnapshots(this.db, ids, day)
				for (const id of run.settled) this.settledDay.set(id, day)
				return run.sent.length
			} catch (err) {
				logger.warn('Workspace usage snapshot failed', { day, error: String(err) })
				return 0
			}
		} finally {
			this.running = false
		}
	}
}
