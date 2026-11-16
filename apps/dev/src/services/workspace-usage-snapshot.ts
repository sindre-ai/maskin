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
 * holds the same figures, so the day can also be read with SQL. Its entity is the workspace itself,
 * so the "already sent today?" check runs on the (workspace, entity) index and needs no new one.
 */
import type { Database } from '@maskin/db'
import { events, sessions, workspaceAiUsage, workspaces } from '@maskin/db/schema'
import { usagePercent } from '@maskin/shared'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { recordEvent } from '../lib/events/record-event'
import { getWorkspacePlanTokenUsage, getWorkspacePlanUsdCentsUsage } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { resolveBillingWindow } from '../routes/billing'
import { resolveSourceActor } from './push-schedule-shared'

export const WORKSPACE_USAGE_SNAPSHOT_EVENT = 'workspace_usage_snapshot'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
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
	plan_limit_usd_cents: number
	input_tokens: number
	output_tokens: number
	session_count: number
}

/**
 * The snapshot of one workspace, or null when there is nothing to send: the workspace is gone, is
 * not metered (enterprise), or has no plan usage in its current period.
 */
export async function readUsageSnapshot(
	db: Pick<Database, 'select'>,
	workspaceId: string,
): Promise<UsageSnapshot | null> {
	const [workspace] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return null

	const { plan, hardCapCents, periodStartSec, periodStartMs } = resolveBillingWindow(workspace)
	if (plan === 'enterprise') return null

	const [usedCents, tokens] = await Promise.all([
		getWorkspacePlanUsdCentsUsage(db, workspaceId, periodStartMs),
		getWorkspacePlanTokenUsage(db, workspaceId, periodStartMs),
	])
	if (usedCents === 0 && tokens.sessionCount === 0) return null

	return {
		workspace_id: workspaceId,
		plan,
		period_start: periodStartSec,
		usage_percent: usagePercent(usedCents, hardCapCents),
		usd_cents_used: usedCents,
		plan_limit_usd_cents: hardCapCents,
		input_tokens: tokens.inputTokens,
		output_tokens: tokens.outputTokens,
		session_count: tokens.sessionCount,
	}
}

async function alreadyClaimed(
	db: Pick<Database, 'select'>,
	workspaceId: string,
	day: string,
): Promise<boolean> {
	const [existing] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, workspaceId),
				eq(events.action, WORKSPACE_USAGE_SNAPSHOT_EVENT),
				sql`${events.data}->>'day' = ${day}`,
			),
		)
		.limit(1)
	return Boolean(existing)
}

/**
 * Sends the snapshot of `workspaceId` for the UTC `day` unless one was already claimed. Returns true
 * when this call claimed the day. The claim is committed before the send, so a failed or
 * privacy-blocked send is not retried the same day.
 */
export async function sendUsageSnapshot(
	db: Database,
	workspaceId: string,
	day: string,
): Promise<boolean> {
	if (await alreadyClaimed(db, workspaceId, day)) return false
	const actorId = await resolveSourceActor(db, workspaceId, NIL_UUID)
	if (!actorId) return false

	const snapshot = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${WORKSPACE_USAGE_SNAPSHOT_EVENT}:${workspaceId}:${day}`}, 0))`,
		)
		if (await alreadyClaimed(tx, workspaceId, day)) return null

		const read = await readUsageSnapshot(tx, workspaceId)
		if (!read) return null
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: WORKSPACE_USAGE_SNAPSHOT_EVENT,
			entityType: 'workspace',
			entityId: workspaceId,
			data: { day, ...read },
		})
		return read
	})
	if (!snapshot) return false

	await capturePosthogEvent(WORKSPACE_USAGE_SNAPSHOT_EVENT, workspaceId, { ...snapshot })
	return true
}

/**
 * Ticks every 30 minutes and sends each active workspace's snapshot once per UTC day. A workspace
 * is settled for the day in memory, so only a restart looks its claim up again.
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

	/** Public for test injection; returns how many snapshots this tick claimed. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		this.running = true
		let claimed = 0
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
			// Drops the ids of workspaces that no longer exist.
			const live = await this.db
				.select({ id: workspaces.id })
				.from(workspaces)
				.where(inArray(workspaces.id, ids))
			for (const ws of live) {
				try {
					if (await sendUsageSnapshot(this.db, ws.id, day)) claimed++
					this.settledDay.set(ws.id, day)
				} catch (err) {
					logger.warn('Workspace usage snapshot failed', {
						workspaceId: ws.id,
						day,
						error: String(err),
					})
				}
			}
		} finally {
			this.running = false
		}
		return claimed
	}
}
