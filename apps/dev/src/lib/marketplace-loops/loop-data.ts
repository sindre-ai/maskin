// Static snapshot data for the template (workspace-neutral) marketplace loops.
//
// The actor system prompts + trigger action prompts are checked in as JSON here
// and seedMarketplaceLoops reads this data (by id) instead of running
// db.select() against local actors/triggers, and snapshots it into
// marketplace_loop_items.
//
// tools.mcpServers has already been stripped from every data/*.json file at
// capture time (it carried live plaintext secrets), so no credential is ever
// committed or published — see loop-snapshot.ts stripMcpServers for the
// redundant runtime guard.
//
// Actor/trigger/skill ids are globally unique UUIDs, so the per-loop snapshots
// are merged into one lookup per entity type below — every loop config calls
// the same getActorData/getTriggerData/getSkillData.

import discoveryActorsData from './data/discovery-actors.json'
import discoverySkillsData from './data/discovery-skills.json'
import discoveryTriggersData from './data/discovery-triggers.json'
import marketWatchActorsData from './data/market-watch-actors.json'
import marketWatchSkillsData from './data/market-watch-skills.json'
import marketWatchTriggersData from './data/market-watch-triggers.json'
import meetingManagerActorsData from './data/meeting-manager-actors.json'
import meetingManagerSkillsData from './data/meeting-manager-skills.json'
import meetingManagerTriggersData from './data/meeting-manager-triggers.json'
import type {
	ActorSnapshotSource,
	SkillSnapshotSource,
	TriggerSnapshotSource,
} from './loop-snapshot'

export interface ActorData extends ActorSnapshotSource {
	id: string
}

export interface TriggerData extends TriggerSnapshotSource {
	id: string
	workspaceId: string
}

export interface SkillData extends SkillSnapshotSource {
	id: string
	workspaceId: string
	// Source actor ids (from the Development workspace's agent_skills rows)
	// this skill is attached to. Captured once at fetch time alongside the
	// skill content — see skillIdsForActor for the inverse lookup.
	attachedActorIds: string[]
}

// Shape shared by every marketplace Loop bundle (./discovery-loop,
// ./market-watch-loop, ./meeting-manager-loop) so dev-bootstrap.ts's MARKETPLACE_SEED_CONFIGS can treat
// them uniformly.
export interface MarketplaceLoopSeedConfig {
	loop: {
		slug: string
		name: string
		version: string
		useCase: string
		description: string
	}
	actorIds: readonly string[]
	triggerIds: readonly string[]
	skillIds: readonly string[]
}

const actorsById: Record<string, ActorData> = {
	...(marketWatchActorsData as Record<string, ActorData>),
	...(meetingManagerActorsData as Record<string, ActorData>),
	...(discoveryActorsData as Record<string, ActorData>),
}

const triggersById: Record<string, TriggerData> = {
	...(marketWatchTriggersData as Record<string, TriggerData>),
	...(meetingManagerTriggersData as Record<string, TriggerData>),
	...(discoveryTriggersData as Record<string, TriggerData>),
}

const skillsById: Record<string, SkillData> = {
	...(marketWatchSkillsData as Record<string, SkillData>),
	...(meetingManagerSkillsData as Record<string, SkillData>),
	...(discoverySkillsData as Record<string, SkillData>),
}

export function getActorData(id: string): ActorData {
	const actor = actorsById[id]
	if (!actor) throw new Error(`actor ${id} not found in the captured actor data`)
	return actor
}

export function getTriggerData(id: string): TriggerData {
	const trigger = triggersById[id]
	if (!trigger) throw new Error(`trigger ${id} not found in the captured trigger data`)
	return trigger
}

// Every trigger whose targetActorId is this actor, in the captured order. This
// is how each single-agent loop (and each bundle) picks up its wiring
// without hardcoding a per-trigger id list that drifts from the live workspace.
export function triggerIdsForActor(actorId: string): string[] {
	return Object.values(triggersById)
		.filter((trigger) => trigger.targetActorId === actorId)
		.map((trigger) => trigger.id)
}

export function getSkillData(id: string): SkillData {
	const skill = skillsById[id]
	if (!skill) throw new Error(`skill ${id} not found in the captured skill data`)
	return skill
}

// Every skill whose attachedActorIds includes this actor, in the captured
// order — the inverse of triggerIdsForActor's targetActorId filter.
export function skillIdsForActor(actorId: string): string[] {
	return Object.values(skillsById)
		.filter((skill) => skill.attachedActorIds.includes(actorId))
		.map((skill) => skill.id)
}
