// Shared constants for the Strategy & Growth Loop catalog bundle.
//
// The bundle contains Strategist, Product Analyst, Product Marketer, and
// Product Pricing Specialist, plus every trigger those four drive — deciding
// what to build, measuring live bets against analytics, and pricing/packaging
// the result. Triggers are derived from the same checked-in snapshot data the
// single-agent packages used.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./package-snapshot; snapshot data in ./package-data.

import {
	DEV_ACTOR_PRODUCT_ANALYST,
	DEV_ACTOR_PRODUCT_MARKETER,
	DEV_ACTOR_PRODUCT_PRICING_SPECIALIST,
	DEV_ACTOR_STRATEGIST,
	DEV_PACKAGE_STRATEGY_GROWTH_LOOP_DESCRIPTION,
	DEV_PACKAGE_STRATEGY_GROWTH_LOOP_NAME,
	DEV_PACKAGE_STRATEGY_GROWTH_LOOP_SLUG,
	DEV_PACKAGE_USE_CASE_GROWTH,
	DEV_PACKAGE_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './package-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './package-snapshot'

export const STRATEGY_GROWTH_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const STRATEGY_GROWTH_PACKAGE = {
	slug: DEV_PACKAGE_STRATEGY_GROWTH_LOOP_SLUG,
	name: DEV_PACKAGE_STRATEGY_GROWTH_LOOP_NAME,
	version: DEV_PACKAGE_VERSION,
	useCase: DEV_PACKAGE_USE_CASE_GROWTH,
	description: DEV_PACKAGE_STRATEGY_GROWTH_LOOP_DESCRIPTION,
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
// it's only published once instead of colliding on the (packageId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const STRATEGY_GROWTH_SKILL_IDS: readonly string[] = [
	...new Set(STRATEGY_GROWTH_ACTOR_IDS.flatMap(skillIdsForActor)),
]
