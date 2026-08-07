// Shared constants for the Build & Ship Loop marketplace bundle.
//
// The bundle contains Planner, Developer, Architect, Designer, Code Reviewer,
// and Workspace Driver, plus every trigger those six drive — so a workspace can
// install the full bet-definition → implement → review → merge pipeline in one
// step. Triggers are derived from the same checked-in snapshot data the
// single-agent loops used.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_ACTOR_ARCHITECT,
	DEV_ACTOR_CODE_REVIEWER,
	DEV_ACTOR_DESIGNER,
	DEV_ACTOR_DEVELOPER,
	DEV_ACTOR_PLANNER,
	DEV_ACTOR_WORKSPACE_DRIVER,
	DEV_LOOP_BUILD_SHIP_DESCRIPTION,
	DEV_LOOP_BUILD_SHIP_NAME,
	DEV_LOOP_BUILD_SHIP_SLUG,
	DEV_LOOP_USE_CASE_DEVELOPMENT,
	DEV_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const DEV_PIPELINE_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const DEV_PIPELINE_LOOP = {
	slug: DEV_LOOP_BUILD_SHIP_SLUG,
	name: DEV_LOOP_BUILD_SHIP_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_DEVELOPMENT,
	description: DEV_LOOP_BUILD_SHIP_DESCRIPTION,
} as const

export const DEV_PIPELINE_ACTOR_IDS = [
	DEV_ACTOR_PLANNER,
	DEV_ACTOR_DEVELOPER,
	DEV_ACTOR_ARCHITECT,
	DEV_ACTOR_DESIGNER,
	DEV_ACTOR_CODE_REVIEWER,
	DEV_ACTOR_WORKSPACE_DRIVER,
] as const

export const DEV_PIPELINE_TRIGGER_IDS: readonly string[] =
	DEV_PIPELINE_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const DEV_PIPELINE_SKILL_IDS: readonly string[] = [
	...new Set(DEV_PIPELINE_ACTOR_IDS.flatMap(skillIdsForActor)),
]
