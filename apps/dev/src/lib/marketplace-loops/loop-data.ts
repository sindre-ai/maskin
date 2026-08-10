// Static snapshot data for the Development-workspace AND Growth-workspace
// marketplace loops.
//
// The local dev Postgres is empty on a fresh clone, and the real actor/trigger
// content lives in the remote Development and Growth workspaces — not in any
// table the publish scripts can query locally. So the actor system prompts +
// trigger action prompts are captured once, live, and checked in as JSON here.
// The publish-*.ts scripts and seedMarketplaceLoops read this data (by id)
// instead of running db.select() against local actors/triggers, and snapshot
// it into marketplace_loop_items.
//
// tools.mcpServers has already been stripped from every data/*.json file at
// capture time (it carried live plaintext secrets), so no credential is ever
// committed or published — see loop-snapshot.ts stripMcpServers for the
// redundant runtime guard.
//
// Actor/trigger/skill ids are globally unique UUIDs regardless of source
// workspace, so the dev-* and growth-* snapshots are merged into one lookup
// per entity type below — every loop config, whichever workspace it was
// captured from, calls the same getActorData/getTriggerData/getSkillData.

import devActorsData from './data/dev-actors.json'
import devSkillsData from './data/dev-skills.json'
import devTriggersData from './data/dev-triggers.json'
import growthActorsData from './data/growth-actors.json'
import growthSkillsData from './data/growth-skills.json'
import growthTriggersData from './data/growth-triggers.json'
import type {
	ActorSnapshotSource,
	ExtensionSnapshotSource,
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

// An extension a loop installs. Unlike actors/triggers/skills there's no
// captured JSON to look this up in — an extension is code registered at boot,
// so the loop config carries the record inline (see ./extension-loops). `id` is
// the hand-authored, stable EXTENSION_ITEM_ID_* constant used as the item's
// source_item_id.
export interface ExtensionData extends ExtensionSnapshotSource {
	id: string
}

// Shape shared by every marketplace Loop bundle (./ccd-loop, ./dev-pipeline-loop,
// ./strategy-growth-loop, ./team-ops-loop) so dev-bootstrap.ts's
// MARKETPLACE_SEED_CONFIGS and the publish-*.ts scripts can treat them uniformly.
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
	// Extensions this loop enables. Optional — only the loops in
	// ./extension-loops ship any.
	extensions?: readonly ExtensionData[]
}

const actorsById: Record<string, ActorData> = {
	...(devActorsData as Record<string, ActorData>),
	...(growthActorsData as Record<string, ActorData>),
}

const triggersById: Record<string, TriggerData> = {
	...(devTriggersData as Record<string, TriggerData>),
	...(growthTriggersData as Record<string, TriggerData>),
}

const skillsById: Record<string, SkillData> = {
	...(devSkillsData as Record<string, SkillData>),
	...(growthSkillsData as Record<string, SkillData>),
}

export function getActorData(id: string): ActorData {
	const actor = actorsById[id]
	if (!actor) throw new Error(`actor ${id} not found in data/dev-actors.json`)
	return actor
}

export function getTriggerData(id: string): TriggerData {
	const trigger = triggersById[id]
	if (!trigger) throw new Error(`trigger ${id} not found in data/dev-triggers.json`)
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
	if (!skill) throw new Error(`skill ${id} not found in data/dev-skills.json`)
	return skill
}

// Every skill whose attachedActorIds includes this actor, in the captured
// order — the inverse of triggerIdsForActor's targetActorId filter.
export function skillIdsForActor(actorId: string): string[] {
	return Object.values(skillsById)
		.filter((skill) => skill.attachedActorIds.includes(actorId))
		.map((skill) => skill.id)
}
