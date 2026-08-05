// Shared constants for the Discover & Research Loop catalog bundle.
//
// The bundle ships five actors — Customer Feedback Agent, Insights Triage
// Agent, Product Ideator, Research Agent, and Summarization Agent — plus every
// trigger those five drive. Triggers are derived from the same checked-in
// snapshot data the single-agent packages used, so the set stays in sync with
// the live workspace instead of a hardcoded, drift-prone id list.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./package-snapshot; snapshot data in ./package-data.

import {
	CCD_ACTOR_CUSTOMER_FEEDBACK,
	CCD_ACTOR_INSIGHTS_TRIAGE,
	CCD_ACTOR_PRODUCT_IDEATOR,
	CCD_PACKAGE_DESCRIPTION,
	CCD_PACKAGE_NAME,
	CCD_PACKAGE_SLUG,
	CCD_PACKAGE_USE_CASE,
	CCD_PACKAGE_VERSION,
	DEV_ACTOR_RESEARCH_AGENT,
	DEV_ACTOR_SUMMARIZATION_AGENT,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './package-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './package-snapshot'

export const CCD_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const CCD_PACKAGE = {
	slug: CCD_PACKAGE_SLUG,
	name: CCD_PACKAGE_NAME,
	version: CCD_PACKAGE_VERSION,
	useCase: CCD_PACKAGE_USE_CASE,
	description: CCD_PACKAGE_DESCRIPTION,
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
// it's only published once instead of colliding on the (packageId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const CCD_SKILL_IDS: readonly string[] = [
	...new Set(CCD_ACTOR_IDS.flatMap(skillIdsForActor)),
]
