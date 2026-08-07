// Shared constants for the Discover & Research Loop marketplace bundle.
//
// The bundle ships five actors — Customer Feedback Agent, Insights Triage
// Agent, Product Ideator, Research Agent, and Summarization Agent — plus every
// trigger those five drive. Triggers are derived from the same checked-in
// snapshot data the single-agent loops used, so the set stays in sync with
// the live workspace instead of a hardcoded, drift-prone id list.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	CCD_ACTOR_CUSTOMER_FEEDBACK,
	CCD_ACTOR_INSIGHTS_TRIAGE,
	CCD_ACTOR_PRODUCT_IDEATOR,
	CCD_LOOP_DESCRIPTION,
	CCD_LOOP_NAME,
	CCD_LOOP_SLUG,
	CCD_LOOP_USE_CASE,
	CCD_LOOP_VERSION,
	DEV_ACTOR_RESEARCH_AGENT,
	DEV_ACTOR_SUMMARIZATION_AGENT,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const CCD_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const CCD_LOOP = {
	slug: CCD_LOOP_SLUG,
	name: CCD_LOOP_NAME,
	version: CCD_LOOP_VERSION,
	useCase: CCD_LOOP_USE_CASE,
	description: CCD_LOOP_DESCRIPTION,
} as const

export const CCD_ACTOR_IDS = [
	CCD_ACTOR_CUSTOMER_FEEDBACK, // Customer Feedback Agent
	CCD_ACTOR_INSIGHTS_TRIAGE, // Insights Triage Agent
	CCD_ACTOR_PRODUCT_IDEATOR, // Product Ideator
	DEV_ACTOR_RESEARCH_AGENT, // Research Agent
	DEV_ACTOR_SUMMARIZATION_AGENT, // Summarization Agent
] as const

export const CCD_TRIGGER_IDS: readonly string[] = CCD_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const CCD_SKILL_IDS: readonly string[] = [
	...new Set(CCD_ACTOR_IDS.flatMap(skillIdsForActor)),
]
