import {
	type AgentCapability,
	CAPABILITY_LEVEL_THRESHOLDS,
	type CapabilityLevel,
} from '@maskin/shared'
import { capturePosthogEvent } from './posthog'

// Server-side PostHog emitter for the capability-rating bet's ship metric
// (`agent_capability_level_advanced`). The bet's success clause is "≥25% of
// agents advance one capability level within 14 days" — that cohort can only
// be counted if this event fires whenever an actor mutation causes the
// computed level to rank strictly higher than before.
//
// distinct_id keys off the actor id (not the workspace) because agents can
// belong to multiple workspaces and the bet's dashboard groups advancement
// events per agent. Mirrors the thinness-events pattern.
//
// `capturePosthogEvent` is best-effort and never throws — see `posthog.ts`.

const LEVEL_RANK: Readonly<Record<CapabilityLevel, number>> = (() => {
	// Rank levels by their threshold minimum so a change to the rubric doesn't
	// require touching this map. Higher min → higher rank.
	const entries = CAPABILITY_LEVEL_THRESHOLDS.slice().sort((a, b) => a.min - b.min)
	const map = {} as Record<CapabilityLevel, number>
	entries.forEach((entry, index) => {
		map[entry.level] = index
	})
	return map
})()

export function isLevelAdvancement(from: CapabilityLevel, to: CapabilityLevel): boolean {
	return LEVEL_RANK[to] > LEVEL_RANK[from]
}

/**
 * Diff two capability snapshots and return the dimension keys whose per-dim
 * score rose. Used to attribute *why* the level advanced — connectors,
 * skills, expertise, etc. Skips dimensions absent from either side.
 */
export function dimensionsRaised(before: AgentCapability, after: AgentCapability): string[] {
	const beforeByKey = new Map(before.dimensions.map((d) => [d.key, d.score]))
	const raised: string[] = []
	for (const dim of after.dimensions) {
		const prior = beforeByKey.get(dim.key)
		if (prior === undefined) continue
		if (dim.score > prior) raised.push(dim.key)
	}
	return raised
}

interface CapabilityLevelAdvancedProps {
	actorId: string
	workspaceId: string | null
	fromLevel: CapabilityLevel
	toLevel: CapabilityLevel
	dimensionsChanged: string[]
}

export async function trackAgentCapabilityLevelAdvanced(
	p: CapabilityLevelAdvancedProps,
): Promise<void> {
	await capturePosthogEvent('agent_capability_level_advanced', p.actorId, {
		actor_id: p.actorId,
		workspace_id: p.workspaceId,
		from_level: p.fromLevel,
		to_level: p.toLevel,
		dimensions_changed: p.dimensionsChanged,
	})
}
