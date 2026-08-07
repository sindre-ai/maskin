// Shared constants for the Meeting Loop marketplace bundle.
//
// The bundle contains Meeting Briefer and Meeting Follow-up — prepares briefs
// ahead of meetings and turns meeting outcomes into follow-up actions and CRM
// updates. Sourced from the live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_USE_CASE_OPERATIONS,
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_MEETING_BRIEFER,
	GROWTH_ACTOR_MEETING_FOLLOWUP,
	GROWTH_LOOP_MEETING_DESCRIPTION,
	GROWTH_LOOP_MEETING_NAME,
	GROWTH_LOOP_MEETING_SLUG,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_MEETING_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_MEETING_LOOP = {
	slug: GROWTH_LOOP_MEETING_SLUG,
	name: GROWTH_LOOP_MEETING_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_OPERATIONS,
	description: GROWTH_LOOP_MEETING_DESCRIPTION,
} as const

export const GROWTH_MEETING_ACTOR_IDS = [
	GROWTH_ACTOR_MEETING_BRIEFER,
	GROWTH_ACTOR_MEETING_FOLLOWUP,
] as const

export const GROWTH_MEETING_TRIGGER_IDS: readonly string[] =
	GROWTH_MEETING_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_MEETING_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_MEETING_ACTOR_IDS.flatMap(skillIdsForActor)),
]
