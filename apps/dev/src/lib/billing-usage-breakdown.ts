import type { Database } from '@maskin/db'
import { actors, sessions, workspaceAiUsage } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'
import {
	aiUsageConds,
	ceilCents,
	planUsageConds,
	sessionUsageCents,
	usdToCents,
} from './llm-routing'
import { loadFlowLookup } from './session-flow'

/** Most named rows per split; everything past it is folded into the other bucket. */
export const USAGE_BREAKDOWN_MAX_ROWS = 10

export type UsageBreakdownRow = {
	/** Model id, agent id or flow id. Null for the sessions that carry none. */
	id: string | null
	name: string
	usd_cents: number
}

export type UsageSplit = {
	rows: UsageBreakdownRow[]
	other_usd_cents: number
}

export type UsageBreakdown = {
	usd_cents_used: number
	by_model: UsageSplit
	by_agent: UsageSplit
	by_flow: UsageSplit
}

type Group = { id: string | null; name: string; cents: number }

/**
 * Whole cents per group that add up to `total`: floor every group, then hand the
 * leftover cents to the groups with the largest fractional part. Rounding each
 * group up on its own would push the parts past the total.
 */
function apportion(groups: Group[], total: number): UsageBreakdownRow[] {
	const parts = groups.map((g) => {
		const floor = Math.floor(Number(g.cents.toFixed(6)))
		return { id: g.id, name: g.name, usd_cents: floor, fraction: g.cents - floor }
	})
	let leftover = total - parts.reduce((a, p) => a + p.usd_cents, 0)
	// Array sort is stable, so equal fractions keep their original order.
	const byFraction = [...parts].sort((a, b) => b.fraction - a.fraction)
	for (const part of byFraction) {
		if (leftover <= 0) break
		part.usd_cents += 1
		leftover -= 1
	}
	return parts
		.filter((p) => p.usd_cents > 0)
		.map((p) => ({ id: p.id, name: p.name, usd_cents: p.usd_cents }))
		.sort(
			(a, b) =>
				b.usd_cents - a.usd_cents ||
				a.name.localeCompare(b.name) ||
				(a.id ?? '').localeCompare(b.id ?? ''),
		)
}

function toSplit(groups: Group[], total: number): UsageSplit {
	const sorted = apportion(groups, total)
	const rows = sorted.slice(0, USAGE_BREAKDOWN_MAX_ROWS)
	const shown = rows.reduce((a, r) => a + r.usd_cents, 0)
	return { rows, other_usd_cents: total - shown }
}

function addTo(
	map: Map<string, Group>,
	key: string,
	id: string | null,
	name: string,
	cents: number,
) {
	const existing = map.get(key)
	if (existing) existing.cents += cents
	else map.set(key, { id, name, cents })
}

/**
 * Plan usage this period split by model, agent and flow, cut from the same
 * session rows `getWorkspacePlanUsdCentsUsage` sums, so each split adds up to
 * `usd_cents_used`.
 *
 * Sessions carry no flow column. A session counts toward the flow that lists its
 * trigger, else the flow its source item sits in (the `in_loop` edge). When
 * several flows qualify the lowest id wins, so a session is never counted
 * twice. A session with neither lands in the "No flow" row.
 */
export async function readUsageBreakdown(
	db: Database,
	workspaceId: string,
	periodStartMs: number,
): Promise<UsageBreakdown> {
	const rows = await db
		.select({
			actorId: sessions.actorId,
			triggerId: sessions.triggerId,
			initiatedFromObjectId: sessions.initiatedFromObjectId,
			modelName: sessions.modelName,
			totalCostUsd: sessions.totalCostUsd,
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(planUsageConds(workspaceId, periodStartMs))

	// Spend with no session (transcribe_file). Read as rows, not a sum, because
	// the splits need each one's model and actor; it counts toward the total
	// exactly as getWorkspacePlanUsdCentsUsage counts it.
	const aiRows = await db
		.select({
			actorId: workspaceAiUsage.actorId,
			model: workspaceAiUsage.model,
			costUsd: workspaceAiUsage.costUsd,
		})
		.from(workspaceAiUsage)
		.where(aiUsageConds(workspaceId, periodStartMs))

	let totalCents = 0
	for (const row of rows) totalCents += sessionUsageCents(row)
	for (const row of aiRows) totalCents += usdToCents(row.costUsd)
	const total = ceilCents(totalCents)

	if (rows.length === 0 && aiRows.length === 0) {
		const empty = { rows: [], other_usd_cents: 0 }
		return { usd_cents_used: total, by_model: empty, by_agent: empty, by_flow: empty }
	}

	const actorIds = new Set(rows.map((r) => r.actorId))
	for (const row of aiRows) if (row.actorId) actorIds.add(row.actorId)
	// A transcription whose agent was since deleted has no actor; with nothing
	// else in the period there is no one to name, and an empty inArray is not a query.
	const agentRows =
		actorIds.size > 0
			? await db
					.select({ id: actors.id, name: actors.name })
					.from(actors)
					.where(inArray(actors.id, [...actorIds]))
			: []
	const agentNames = new Map(agentRows.map((a) => [a.id, a.name]))

	const flows = await loadFlowLookup(db, workspaceId, rows)

	const byModel = new Map<string, Group>()
	const byAgent = new Map<string, Group>()
	const byFlow = new Map<string, Group>()
	for (const row of rows) {
		const cents = sessionUsageCents(row)
		addTo(byModel, row.modelName ?? '', row.modelName, row.modelName ?? 'Unknown model', cents)
		addTo(byAgent, row.actorId, row.actorId, agentNames.get(row.actorId) ?? 'Unknown agent', cents)
		const loopId = flows.flowIdOf(row)
		addTo(
			byFlow,
			loopId ?? '',
			loopId,
			loopId ? (flows.titles.get(loopId) ?? 'Flow') : 'No flow',
			cents,
		)
	}
	// Session-less spend carries its model and actor, and belongs to no flow.
	for (const row of aiRows) {
		const cents = usdToCents(row.costUsd)
		addTo(byModel, row.model, row.model, row.model, cents)
		addTo(
			byAgent,
			row.actorId ?? '',
			row.actorId,
			(row.actorId ? agentNames.get(row.actorId) : undefined) ?? 'Unknown agent',
			cents,
		)
		addTo(byFlow, '', null, 'No flow', cents)
	}

	return {
		usd_cents_used: total,
		by_model: toSplit([...byModel.values()], total),
		by_agent: toSplit([...byAgent.values()], total),
		by_flow: toSplit([...byFlow.values()], total),
	}
}
