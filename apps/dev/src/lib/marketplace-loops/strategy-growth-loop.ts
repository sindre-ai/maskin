// Shared constants for the Strategy & Growth Loop marketplace bundle.
//
// The bundle contains Strategist, Product Analyst, Product Marketer, and
// Product Pricing Specialist, plus every trigger those four drive — deciding
// what to build, measuring live bets against analytics, and pricing/packaging
// the result. Triggers are derived from the same checked-in snapshot data the
// single-agent loops used.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_ACTOR_PRODUCT_ANALYST,
	DEV_ACTOR_PRODUCT_MARKETER,
	DEV_ACTOR_PRODUCT_PRICING_SPECIALIST,
	DEV_ACTOR_STRATEGIST,
	DEV_LOOP_STRATEGY_GROWTH_DESCRIPTION,
	DEV_LOOP_STRATEGY_GROWTH_NAME,
	DEV_LOOP_STRATEGY_GROWTH_SLUG,
	DEV_LOOP_USE_CASE_GROWTH,
	DEV_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const STRATEGY_GROWTH_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const STRATEGY_GROWTH_LOOP = {
	slug: DEV_LOOP_STRATEGY_GROWTH_SLUG,
	name: DEV_LOOP_STRATEGY_GROWTH_NAME,
	version: DEV_LOOP_VERSION,
	useCase: DEV_LOOP_USE_CASE_GROWTH,
	description: DEV_LOOP_STRATEGY_GROWTH_DESCRIPTION,
} as const

export const STRATEGY_GROWTH_ACTOR_IDS = [
	DEV_ACTOR_STRATEGIST,
	DEV_ACTOR_PRODUCT_ANALYST,
	DEV_ACTOR_PRODUCT_MARKETER,
	DEV_ACTOR_PRODUCT_PRICING_SPECIALIST,
] as const

export const STRATEGY_GROWTH_TRIGGER_IDS: readonly string[] =
	STRATEGY_GROWTH_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const STRATEGY_GROWTH_SKILL_IDS: readonly string[] = [
	...new Set(STRATEGY_GROWTH_ACTOR_IDS.flatMap(skillIdsForActor)),
]
