// Shared constants for the SDR Outreach Loop marketplace bundle.
//
// The bundle contains Sales Rep, Sales Rep (Magnus), Rune Værk, and Sales
// Coach — runs daily territory-based outbound (first touches, personalized
// follow-ups, no-reply fallback ladders) and coaches messaging on what's
// converting. Sourced from the live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_RUNE_VAERK,
	GROWTH_ACTOR_SALES_COACH,
	GROWTH_ACTOR_SALES_REP,
	GROWTH_ACTOR_SALES_REP_MAGNUS,
	GROWTH_LOOP_SDR_OUTREACH_DESCRIPTION,
	GROWTH_LOOP_SDR_OUTREACH_NAME,
	GROWTH_LOOP_SDR_OUTREACH_SLUG,
	GROWTH_LOOP_USE_CASE_SALES,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_SDR_OUTREACH_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_SDR_OUTREACH_LOOP = {
	slug: GROWTH_LOOP_SDR_OUTREACH_SLUG,
	name: GROWTH_LOOP_SDR_OUTREACH_NAME,
	version: DEV_LOOP_VERSION,
	useCase: GROWTH_LOOP_USE_CASE_SALES,
	description: GROWTH_LOOP_SDR_OUTREACH_DESCRIPTION,
} as const

export const GROWTH_SDR_OUTREACH_ACTOR_IDS = [
	GROWTH_ACTOR_SALES_REP,
	GROWTH_ACTOR_SALES_REP_MAGNUS,
	GROWTH_ACTOR_RUNE_VAERK,
	GROWTH_ACTOR_SALES_COACH,
] as const

export const GROWTH_SDR_OUTREACH_TRIGGER_IDS: readonly string[] =
	GROWTH_SDR_OUTREACH_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_SDR_OUTREACH_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_SDR_OUTREACH_ACTOR_IDS.flatMap(skillIdsForActor)),
]
