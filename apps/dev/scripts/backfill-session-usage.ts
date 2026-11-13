// Backfill tokens and cost for sessions that closed with zero usage recorded.
//
// Since 23 Oct, sessions that closed idle or as helpers saved no usage before closing, so their
// row shows zero tokens and zero cost (fixed for new closes in #2513). Their stdout is still in
// `session_logs` until the 30 day log prune removes it (non-interactive sessions only; idle chats
// are interactive and are never pruned). This script sums the `result` lines that are still
// stored, the same way the close paths do (`sumUncountedResultUsage`), and writes them to the row.
// It never estimates: a session with no `result` line in its logs is counted as unrecoverable and
// left alone.
//
// Dry run by default. It prints, without writing anything:
//   - how many candidate sessions hold a result line versus not (split by why not), and
//   - per workspace, what the recovered cost does to plan cap usage.
// Plan cap usage (`getWorkspacePlanUsdCentsUsage`) sums maskin_plan sessions created in the current
// billing period, so recovered cost on those sessions raises "used". Past the cap, the next credit
// debit in that workspace charges the new overage (`debitCreditForSession` bills used minus cap
// minus what earlier debits accounted for). This script does not run a debit itself.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-session-usage.ts
//   ... --apply                 write the recovered usage
//   ... --apply --skip-overage  write, but leave out workspaces where it would add new overage
//   ... --since=2026-10-23T00:00:00Z --workspace=<uuid> --limit=<n>
//
// Idempotent: only rows with zero usage and no watermark are touched, and the write re-checks that
// in its WHERE, so a re-run or a live writer racing it adds nothing twice. PostHog events that were
// already sent with zero tokens are not re-sent.

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { sessionLogs, sessions, workspaces } from '@maskin/db/schema'
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
	LLM_ROUTE_MASKIN_PLAN,
	getWorkspacePlanCap,
	getWorkspacePlanUsdCentsUsage,
	sessionUsageCents,
} from '../src/lib/llm-routing'
import {
	type SessionUsage,
	resolveSessionCostUsd,
	sumUncountedResultUsage,
} from '../src/services/usage-parser'

const DEFAULT_SINCE = '2026-10-23T00:00:00Z'
const BATCH = 200

export type BackfillOptions = {
	since: Date
	apply: boolean
	skipOverage: boolean
	workspaceId?: string
	limit?: number
}

type Recovered = {
	id: string
	workspaceId: string
	route: string
	createdAt: Date
	usage: SessionUsage
	costUsd: number | null
	watermark: { logId: number; cliCost: number }
}

type WorkspaceImpact = {
	workspaceId: string
	plan: string
	capCents: number | null
	usedCents: number
	addedCents: number
	newOverageCents: number
	sessions: number
}

export type BackfillReport = {
	candidates: number
	recoverable: number
	noLogsLeft: number
	logsWithoutResult: number
	tokens: { input: number; output: number; cacheCreation: number; cacheRead: number }
	costUsd: number
	workspaces: WorkspaceImpact[]
	written: number
	skippedOverage: number
	lostRace: number
}

const zeroUsage = and(
	sql`COALESCE(${sessions.inputTokens}, 0) = 0`,
	sql`COALESCE(${sessions.outputTokens}, 0) = 0`,
	sql`COALESCE(${sessions.cacheCreationInputTokens}, 0) = 0`,
	sql`COALESCE(${sessions.cacheReadInputTokens}, 0) = 0`,
	sql`COALESCE(${sessions.totalCostUsd}, 0) = 0`,
	isNull(sessions.usageCountedLogId),
)

export async function backfillSessionUsage(
	db: Database,
	opts: BackfillOptions,
): Promise<BackfillReport> {
	const report: BackfillReport = {
		candidates: 0,
		recoverable: 0,
		noLogsLeft: 0,
		logsWithoutResult: 0,
		tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
		costUsd: 0,
		workspaces: [],
		written: 0,
		skippedOverage: 0,
		lostRace: 0,
	}
	const recovered: Recovered[] = []

	let after = ''
	while (opts.limit === undefined || report.candidates < opts.limit) {
		const batch = await db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				config: sessions.config,
				modelName: sessions.modelName,
				createdAt: sessions.createdAt,
			})
			.from(sessions)
			.where(
				and(
					isNotNull(sessions.completedAt),
					gte(sessions.completedAt, opts.since),
					opts.workspaceId ? eq(sessions.workspaceId, opts.workspaceId) : undefined,
					after ? gt(sessions.id, after) : undefined,
					zeroUsage,
				),
			)
			.orderBy(asc(sessions.id))
			.limit(BATCH)
		if (batch.length === 0) break
		after = batch[batch.length - 1]?.id ?? after

		for (const row of batch) {
			report.candidates++
			const uncounted = await sumUncountedResultUsage(db, row.id, { logId: null, cliCost: null })
			if (!uncounted) {
				const [anyStdout] = await db
					.select({ id: sessionLogs.id })
					.from(sessionLogs)
					.where(and(eq(sessionLogs.sessionId, row.id), eq(sessionLogs.stream, 'stdout')))
					.limit(1)
				if (anyStdout) report.logsWithoutResult++
				else report.noLogsLeft++
				continue
			}
			const config = (row.config ?? {}) as Record<string, unknown>
			const route = typeof config.llm_route === 'string' ? config.llm_route : ''
			const costUsd = await resolveSessionCostUsd({
				route,
				modelName: row.modelName,
				usage: uncounted.usage,
			})
			report.recoverable++
			report.tokens.input += uncounted.usage.inputTokens ?? 0
			report.tokens.output += uncounted.usage.outputTokens ?? 0
			report.tokens.cacheCreation += uncounted.usage.cacheCreationInputTokens ?? 0
			report.tokens.cacheRead += uncounted.usage.cacheReadInputTokens ?? 0
			report.costUsd += costUsd ?? 0
			recovered.push({
				id: row.id,
				workspaceId: row.workspaceId,
				route,
				createdAt: row.createdAt,
				usage: uncounted.usage,
				costUsd,
				watermark: uncounted.watermark,
			})
			if (opts.limit !== undefined && report.candidates >= opts.limit) break
		}
	}

	report.workspaces = await planCapImpact(db, recovered)
	const blocked = new Set(
		opts.skipOverage
			? report.workspaces.filter((w) => w.newOverageCents > 0).map((w) => w.workspaceId)
			: [],
	)

	if (opts.apply) {
		for (const r of recovered) {
			if (blocked.has(r.workspaceId) && r.route === LLM_ROUTE_MASKIN_PLAN) {
				report.skippedOverage++
				continue
			}
			const updated = await db
				.update(sessions)
				.set({
					inputTokens: r.usage.inputTokens ?? undefined,
					outputTokens: r.usage.outputTokens ?? undefined,
					cacheCreationInputTokens: r.usage.cacheCreationInputTokens ?? undefined,
					cacheReadInputTokens: r.usage.cacheReadInputTokens ?? undefined,
					totalCostUsd: r.costUsd != null ? String(r.costUsd) : undefined,
					// A close that saved only the last turn's duration keeps it.
					durationMs:
						r.usage.durationMs != null
							? sql`CASE WHEN COALESCE(${sessions.durationMs}, 0) = 0 THEN ${r.usage.durationMs} ELSE ${sessions.durationMs} END`
							: undefined,
					usageCountedLogId: r.watermark.logId,
					usageCountedCliCost: String(r.watermark.cliCost),
				})
				.where(and(eq(sessions.id, r.id), zeroUsage))
				.returning({ id: sessions.id })
			if (updated.length === 0) report.lostRace++
			else report.written++
		}
	}
	return report
}

/**
 * Per workspace: what the recovered maskin_plan cost adds to this period's cap usage. Uses the
 * same per-session figure and period filter as `getWorkspacePlanUsdCentsUsage`, so the numbers
 * match what the cap check and the credit debit will see after the write.
 */
async function planCapImpact(db: Database, recovered: Recovered[]): Promise<WorkspaceImpact[]> {
	const plan = recovered.filter((r) => r.route === LLM_ROUTE_MASKIN_PLAN)
	const workspaceIds = [...new Set(plan.map((r) => r.workspaceId))]
	if (workspaceIds.length === 0) return []
	const rows = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(inArray(workspaces.id, workspaceIds))

	const out: WorkspaceImpact[] = []
	for (const ws of rows) {
		const settings = (ws.settings ?? {}) as Parameters<typeof getWorkspacePlanCap>[0]
		const billing = settings.billing
		const periodStartMs =
			typeof billing?.period_start === 'number' ? billing.period_start * 1000 : undefined
		const inPeriod = plan.filter(
			(r) =>
				r.workspaceId === ws.id &&
				(periodStartMs === undefined || r.createdAt.getTime() >= periodStartMs),
		)
		if (inPeriod.length === 0) continue
		let addedCents = 0
		for (const r of inPeriod) {
			addedCents += sessionUsageCents({
				totalCostUsd: r.costUsd != null ? String(r.costUsd) : null,
				inputTokens: r.usage.inputTokens,
				outputTokens: r.usage.outputTokens,
			})
		}
		const usedCents = await getWorkspacePlanUsdCentsUsage(db, ws.id, periodStartMs)
		const capCents = getWorkspacePlanCap(settings)
		const overBefore = capCents === null ? 0 : Math.max(0, usedCents - capCents)
		const overAfter = capCents === null ? 0 : Math.max(0, usedCents + addedCents - capCents)
		out.push({
			workspaceId: ws.id,
			plan: billing?.plan ?? 'trial',
			capCents,
			usedCents,
			addedCents: Math.round(addedCents),
			newOverageCents: Math.ceil(overAfter - overBefore),
			sessions: inPeriod.length,
		})
	}
	return out.sort((a, b) => b.newOverageCents - a.newOverageCents || b.addedCents - a.addedCents)
}

function parseArgs(argv: string[]): BackfillOptions {
	const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
	const since = new Date(flag('since') ?? DEFAULT_SINCE)
	if (Number.isNaN(since.getTime())) throw new Error('--since must be an ISO date')
	const limit = flag('limit')
	return {
		since,
		apply: argv.includes('--apply'),
		skipOverage: argv.includes('--skip-overage'),
		workspaceId: flag('workspace'),
		limit: limit ? Number(limit) : undefined,
	}
}

export async function main() {
	const databaseUrl = process.env.DATABASE_URL
	if (!databaseUrl) {
		console.error('DATABASE_URL is required.')
		process.exit(1)
	}
	const opts = parseArgs(process.argv.slice(2))
	const report = await backfillSessionUsage(createDb(databaseUrl), opts)

	console.log(opts.apply ? 'APPLIED' : 'DRY RUN (nothing written, pass --apply to write)')
	console.log(
		`Since ${opts.since.toISOString()}${opts.workspaceId ? `, workspace ${opts.workspaceId}` : ''}`,
	)
	console.log(`Candidates with zero usage: ${report.candidates}`)
	console.log(`  recoverable (result line in logs): ${report.recoverable}`)
	console.log(`  not recoverable, no stdout logs left: ${report.noLogsLeft}`)
	console.log(`  not recoverable, logs hold no result line: ${report.logsWithoutResult}`)
	console.log(
		`Recoverable totals: input ${report.tokens.input}, output ${report.tokens.output}, cache write ${report.tokens.cacheCreation}, cache read ${report.tokens.cacheRead}, cost $${report.costUsd.toFixed(2)}`,
	)
	console.log(
		`Plan cap impact (maskin_plan sessions in the current billing period), ${report.workspaces.length} workspaces:`,
	)
	for (const w of report.workspaces) {
		console.log(
			`  ${w.workspaceId} plan=${w.plan} sessions=${w.sessions} used=${w.usedCents}c cap=${w.capCents ?? 'none'}c added=${w.addedCents}c new_overage=${w.newOverageCents}c`,
		)
	}
	if (opts.apply) {
		console.log(
			`Written ${report.written}, skipped for overage ${report.skippedOverage}, already changed by another writer ${report.lostRace}`,
		)
	}
	process.exit(0)
}

const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}
