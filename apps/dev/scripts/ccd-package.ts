// Shared constants for the Customer Continuous Discovery catalog bundle.
//
// The bundle now ships three actors — Customer Feedback Agent, Insights Triage
// Agent, and Product Ideator — plus every trigger those three drive. (The old
// Customer Curator actor no longer exists in the live workspace, so it and its
// close-the-loop triggers are dropped.) Triggers are derived from the same
// checked-in snapshot data the single-agent packages use, so the set stays in
// sync with the live workspace instead of a hardcoded, drift-prone id list.
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
} from '@maskin/shared'
import { triggerIdsForActor } from './package-data'

export { actorSnapshot, triggerSnapshot } from './package-snapshot'

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
] as const

export const CCD_TRIGGER_IDS: readonly string[] = CCD_ACTOR_IDS.flatMap(triggerIdsForActor)
