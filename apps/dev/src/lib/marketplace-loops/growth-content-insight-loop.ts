// Shared constants for the Content & Insight Loop marketplace bundle.
//
// The bundle contains Content Writer, Insight Harvester, and Insights
// Synthesizer — turns inspiration and market signal into structured insights,
// clusters them into patterns, and drafts customer-facing content grounded in
// the source. Sourced from the live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d).
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_VERSION,
	GROWTH_ACTOR_CONTENT_WRITER,
	GROWTH_ACTOR_INSIGHTS_SYNTHESIZER,
	GROWTH_ACTOR_INSIGHT_HARVESTER,
	GROWTH_LOOP_CONTENT_INSIGHT_DESCRIPTION,
	GROWTH_LOOP_CONTENT_INSIGHT_NAME,
	GROWTH_LOOP_CONTENT_INSIGHT_SLUG,
	GROWTH_LOOP_USE_CASE_MARKETING,
	GROWTH_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GROWTH_CONTENT_INSIGHT_SOURCE_WORKSPACE_ID = GROWTH_SOURCE_WORKSPACE_ID

export const GROWTH_CONTENT_INSIGHT_LOOP = {
	slug: GROWTH_LOOP_CONTENT_INSIGHT_SLUG,
	name: GROWTH_LOOP_CONTENT_INSIGHT_NAME,
	version: DEV_LOOP_VERSION,
	useCase: GROWTH_LOOP_USE_CASE_MARKETING,
	description: GROWTH_LOOP_CONTENT_INSIGHT_DESCRIPTION,
} as const

export const GROWTH_CONTENT_INSIGHT_ACTOR_IDS = [
	GROWTH_ACTOR_CONTENT_WRITER,
	GROWTH_ACTOR_INSIGHT_HARVESTER,
	GROWTH_ACTOR_INSIGHTS_SYNTHESIZER,
] as const

export const GROWTH_CONTENT_INSIGHT_TRIGGER_IDS: readonly string[] =
	GROWTH_CONTENT_INSIGHT_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GROWTH_CONTENT_INSIGHT_SKILL_IDS: readonly string[] = [
	...new Set(GROWTH_CONTENT_INSIGHT_ACTOR_IDS.flatMap(skillIdsForActor)),
]
