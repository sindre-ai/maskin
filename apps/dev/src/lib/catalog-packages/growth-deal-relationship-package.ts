// Shared constants for the Deal & Relationship Loop catalog bundle.
//
// The bundle contains Deal Closer, Relationship Warmer, and SalesOps —
// advances qualified conversations toward close, nurtures existing
// relationships, and keeps CRM hygiene (dedup, data quality) on a standing
// cadence. Sourced from the live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./package-snapshot; snapshot data in ./package-data.

import {
	DEV_PACKAGE_VERSION,
	GROWTH_ACTOR_DEAL_CLOSER,
	GROWTH_ACTOR_RELATIONSHIP_WARMER,
	GROWTH_ACTOR_SALESOPS,
	GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_DESCRIPTION,
	GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_NAME,
	GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_SLUG,
	GROWTH_PACKAGE_USE_CASE_SALES,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './package-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './package-snapshot'

export const GROWTH_DEAL_RELATIONSHIP_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_DEAL_RELATIONSHIP_PACKAGE = {
	slug: GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_SLUG,
	name: GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_NAME,
	version: DEV_PACKAGE_VERSION,
	useCase: GROWTH_PACKAGE_USE_CASE_SALES,
	description: GROWTH_PACKAGE_DEAL_RELATIONSHIP_LOOP_DESCRIPTION,
} as const

export const GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS = [
	GROWTH_ACTOR_DEAL_CLOSER,
	GROWTH_ACTOR_RELATIONSHIP_WARMER,
	GROWTH_ACTOR_SALESOPS,
] as const

export const GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS: readonly string[] =
	GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (packageId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_DEAL_RELATIONSHIP_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
