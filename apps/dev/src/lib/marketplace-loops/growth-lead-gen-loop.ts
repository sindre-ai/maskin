// Shared constants for the Lead Gen & Qualification Loop marketplace bundle.
//
// The bundle contains Prospector, Qualifier, and HubSpot Liaison — sources
// net-new ICP companies and contacts, scores and routes them by fit and
// persona, and keeps the CRM in sync with the pipeline. Sourced from the live
// Growth workspace (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_HUBSPOT_LIAISON,
	GROWTH_ACTOR_PROSPECTOR,
	GROWTH_ACTOR_QUALIFIER,
	GROWTH_LOOP_LEAD_GEN_QUALIFICATION_DESCRIPTION,
	GROWTH_LOOP_LEAD_GEN_QUALIFICATION_NAME,
	GROWTH_LOOP_LEAD_GEN_QUALIFICATION_SLUG,
	GROWTH_LOOP_USE_CASE_SALES,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_LEAD_GEN_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_LEAD_GEN_LOOP = {
	slug: GROWTH_LOOP_LEAD_GEN_QUALIFICATION_SLUG,
	name: GROWTH_LOOP_LEAD_GEN_QUALIFICATION_NAME,
	version: DEV_LOOP_VERSION,
	useCase: GROWTH_LOOP_USE_CASE_SALES,
	description: GROWTH_LOOP_LEAD_GEN_QUALIFICATION_DESCRIPTION,
} as const

export const GROWTH_LEAD_GEN_ACTOR_IDS = [
	GROWTH_ACTOR_PROSPECTOR,
	GROWTH_ACTOR_QUALIFIER,
	GROWTH_ACTOR_HUBSPOT_LIAISON,
] as const

export const GROWTH_LEAD_GEN_TRIGGER_IDS: readonly string[] =
	GROWTH_LEAD_GEN_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_LEAD_GEN_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_LEAD_GEN_ACTOR_IDS.flatMap(skillIdsForActor)),
]
