// Shared constants for the Development Pipeline catalog bundle.
//
// The bundle now contains Developer + Code Reviewer and every trigger those two
// drive, so a workspace can install the full implement → review → merge
// pipeline in one step. The old Acceptance Validator actor was absorbed into
// the Code Reviewer (which now owns review, validation, and the risk-gated
// merge), so it and its hand-off trigger are dropped. Triggers are derived from
// the same checked-in snapshot data the single-agent packages use.
//
// Exported so the publish script and its tests can share the exact same shape.
// Snapshot helpers live in ./package-snapshot; snapshot data in ./package-data.

import {
	DEV_ACTOR_CODE_REVIEWER,
	DEV_ACTOR_DEVELOPER,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_DESCRIPTION,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_NAME,
	DEV_PACKAGE_DEVELOPMENT_PIPELINE_SLUG,
	DEV_PACKAGE_USE_CASE_DEVELOPMENT,
	DEV_PACKAGE_VERSION,
} from '@maskin/shared'
import { triggerIdsForActor } from './package-data'

export { actorSnapshot, triggerSnapshot } from './package-snapshot'

export const DEV_PIPELINE_SOURCE_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'

export const DEV_PIPELINE_PACKAGE = {
	slug: DEV_PACKAGE_DEVELOPMENT_PIPELINE_SLUG,
	name: DEV_PACKAGE_DEVELOPMENT_PIPELINE_NAME,
	version: DEV_PACKAGE_VERSION,
	useCase: DEV_PACKAGE_USE_CASE_DEVELOPMENT,
	description: DEV_PACKAGE_DEVELOPMENT_PIPELINE_DESCRIPTION,
} as const

export const DEV_PIPELINE_ACTOR_IDS = [DEV_ACTOR_DEVELOPER, DEV_ACTOR_CODE_REVIEWER] as const

export const DEV_PIPELINE_TRIGGER_IDS: readonly string[] =
	DEV_PIPELINE_ACTOR_IDS.flatMap(triggerIdsForActor)
