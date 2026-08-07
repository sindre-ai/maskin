// Shared constants for the Growth Bet Loop marketplace bundle.
//
// The bundle contains Growth Strategist, Growth Manager, and Growth Ideator —
// shapes growth bets from signal to hypothesis, opens and adjudicates their
// measurement windows, and generates new experiment ideas from what worked.
// Sourced from the live Growth workspace (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_USE_CASE_GROWTH,
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_GROWTH_IDEATOR,
	GROWTH_ACTOR_GROWTH_MANAGER,
	GROWTH_ACTOR_GROWTH_STRATEGIST,
	GROWTH_LOOP_GROWTH_BET_DESCRIPTION,
	GROWTH_LOOP_GROWTH_BET_NAME,
	GROWTH_LOOP_GROWTH_BET_SLUG,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_BET_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_BET_LOOP = {
	slug: GROWTH_LOOP_GROWTH_BET_SLUG,
	name: GROWTH_LOOP_GROWTH_BET_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_GROWTH,
	description: GROWTH_LOOP_GROWTH_BET_DESCRIPTION,
} as const

export const GROWTH_BET_ACTOR_IDS = [
	GROWTH_ACTOR_GROWTH_STRATEGIST,
	GROWTH_ACTOR_GROWTH_MANAGER,
	GROWTH_ACTOR_GROWTH_IDEATOR,
] as const

export const GROWTH_BET_TRIGGER_IDS: readonly string[] =
	GROWTH_BET_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_BET_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_BET_ACTOR_IDS.flatMap(skillIdsForActor)),
]
