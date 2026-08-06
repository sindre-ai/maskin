// Shared constants for the Brand & Demand Loop catalog bundle.
//
// The bundle contains Influencer Manager, Demo Video Producer, Visual
// Designer, Search & AI Visibility Analyst, and Event Producer — builds
// external-facing brand assets to drive inbound demand. Sourced from the live
// Growth workspace (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./package-snapshot; snapshot data in ./package-data.

import {
	DEV_PACKAGE_VERSION,
	GROWTH_ACTOR_DEMO_VIDEO_PRODUCER,
	GROWTH_ACTOR_EVENT_PRODUCER,
	GROWTH_ACTOR_INFLUENCER_MANAGER,
	GROWTH_ACTOR_SEARCH_AI_VISIBILITY_ANALYST,
	GROWTH_ACTOR_VISUAL_DESIGNER,
	GROWTH_PACKAGE_BRAND_DEMAND_LOOP_DESCRIPTION,
	GROWTH_PACKAGE_BRAND_DEMAND_LOOP_NAME,
	GROWTH_PACKAGE_BRAND_DEMAND_LOOP_SLUG,
	GROWTH_PACKAGE_USE_CASE_MARKETING,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './package-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './package-snapshot'

export const GROWTH_BRAND_DEMAND_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_BRAND_DEMAND_PACKAGE = {
	slug: GROWTH_PACKAGE_BRAND_DEMAND_LOOP_SLUG,
	name: GROWTH_PACKAGE_BRAND_DEMAND_LOOP_NAME,
	version: DEV_PACKAGE_VERSION,
	useCase: GROWTH_PACKAGE_USE_CASE_MARKETING,
	description: GROWTH_PACKAGE_BRAND_DEMAND_LOOP_DESCRIPTION,
} as const

export const GROWTH_BRAND_DEMAND_ACTOR_IDS = [
	GROWTH_ACTOR_INFLUENCER_MANAGER,
	GROWTH_ACTOR_DEMO_VIDEO_PRODUCER,
	GROWTH_ACTOR_VISUAL_DESIGNER,
	GROWTH_ACTOR_SEARCH_AI_VISIBILITY_ANALYST,
	GROWTH_ACTOR_EVENT_PRODUCER,
] as const

export const GROWTH_BRAND_DEMAND_TRIGGER_IDS: readonly string[] =
	GROWTH_BRAND_DEMAND_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (packageId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_BRAND_DEMAND_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_BRAND_DEMAND_ACTOR_IDS.flatMap(skillIdsForActor)),
]
