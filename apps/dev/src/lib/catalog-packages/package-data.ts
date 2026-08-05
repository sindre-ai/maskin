// Static snapshot data for the Development-workspace catalog packages.
//
// The local dev Postgres is empty on a fresh clone, and the real actor/trigger
// content lives in the remote Development workspace — not in any table the
// publish scripts can query locally. So the actor system prompts + trigger
// action prompts are captured once, live, and checked in as JSON here. The
// publish-*.ts scripts read this data (by id) instead of running db.select()
// against local actors/triggers, and snapshot it into catalog_package_items.
//
// tools.mcpServers has already been stripped from dev-actors.json at capture
// time (it carried live plaintext secrets), so no credential is ever committed
// or published — see package-snapshot.ts stripMcpServers for the redundant
// runtime guard.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
	ActorSnapshotSource,
	SkillSnapshotSource,
	TriggerSnapshotSource,
} from './package-snapshot'

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

// Shape shared by every catalog Loop bundle (./ccd-package, ./dev-pipeline-package,
// ./strategy-growth-package, ./team-ops-package) so dev-bootstrap.ts's
// CATALOG_SEED_CONFIGS and the publish-*.ts scripts can treat them uniformly.
export interface CatalogPackageSeedConfig {
	package: {
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

const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data')

const actorsById = JSON.parse(readFileSync(join(dataDir, 'dev-actors.json'), 'utf8')) as Record<
	string,
	ActorData
>

const triggersById = JSON.parse(readFileSync(join(dataDir, 'dev-triggers.json'), 'utf8')) as Record<
	string,
	TriggerData
>

const skillsById = JSON.parse(readFileSync(join(dataDir, 'dev-skills.json'), 'utf8')) as Record<
	string,
	SkillData
>

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
// is how each single-agent package (and each bundle) picks up its wiring
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
