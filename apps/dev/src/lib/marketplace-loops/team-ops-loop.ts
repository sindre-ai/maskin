// Shared constants for the Team Ops & Retro Loop marketplace bundle.
//
// The bundle contains Workspace Coach and Retro Knowledge Author, plus every
// trigger those two drive — observing longitudinal team and agent performance
// patterns, and writing retros and validated knowledge articles at bet terminal
// events. Triggers are derived from the same checked-in snapshot data the
// single-agent loops used.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR,
	DEV_ACTOR_WORKSPACE_COACH,
	DEV_LOOP_TEAM_OPS_RETRO_DESCRIPTION,
	DEV_LOOP_TEAM_OPS_RETRO_NAME,
	DEV_LOOP_TEAM_OPS_RETRO_SLUG,
	DEV_LOOP_USE_CASE_OPERATIONS,
	DEV_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const TEAM_OPS_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const TEAM_OPS_LOOP = {
	slug: DEV_LOOP_TEAM_OPS_RETRO_SLUG,
	name: DEV_LOOP_TEAM_OPS_RETRO_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_OPERATIONS,
	description: DEV_LOOP_TEAM_OPS_RETRO_DESCRIPTION,
} as const

export const TEAM_OPS_ACTOR_IDS = [
	DEV_ACTOR_WORKSPACE_COACH,
	DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR,
] as const

export const TEAM_OPS_TRIGGER_IDS: readonly string[] =
	TEAM_OPS_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const TEAM_OPS_SKILL_IDS: readonly string[] = [
	...new Set(TEAM_OPS_ACTOR_IDS.flatMap(skillIdsForActor)),
]
