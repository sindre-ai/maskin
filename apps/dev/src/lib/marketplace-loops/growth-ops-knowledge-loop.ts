// Shared constants for the Ops & Knowledge Loop marketplace bundle.
//
// The bundle contains Knowledge Author, Workspace Coach, Workspace Driver, and
// Chief of Staff — writes validated knowledge articles, observes longitudinal
// workspace and agent performance, and handles day-to-day workspace
// coordination. Sourced from the live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_USE_CASE_OPERATIONS,
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_CHIEF_OF_STAFF,
	GROWTH_ACTOR_KNOWLEDGE_AUTHOR,
	GROWTH_ACTOR_WORKSPACE_COACH,
	GROWTH_ACTOR_WORKSPACE_DRIVER,
	GROWTH_LOOP_OPS_KNOWLEDGE_DESCRIPTION,
	GROWTH_LOOP_OPS_KNOWLEDGE_NAME,
	GROWTH_LOOP_OPS_KNOWLEDGE_SLUG,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_OPS_KNOWLEDGE_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_OPS_KNOWLEDGE_LOOP = {
	slug: GROWTH_LOOP_OPS_KNOWLEDGE_SLUG,
	name: GROWTH_LOOP_OPS_KNOWLEDGE_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_OPERATIONS,
	description: GROWTH_LOOP_OPS_KNOWLEDGE_DESCRIPTION,
} as const

export const GROWTH_OPS_KNOWLEDGE_ACTOR_IDS = [
	GROWTH_ACTOR_KNOWLEDGE_AUTHOR,
	GROWTH_ACTOR_WORKSPACE_COACH,
	GROWTH_ACTOR_WORKSPACE_DRIVER,
	GROWTH_ACTOR_CHIEF_OF_STAFF,
] as const

export const GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS: readonly string[] =
	GROWTH_OPS_KNOWLEDGE_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_OPS_KNOWLEDGE_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_OPS_KNOWLEDGE_ACTOR_IDS.flatMap(skillIdsForActor)),
]
