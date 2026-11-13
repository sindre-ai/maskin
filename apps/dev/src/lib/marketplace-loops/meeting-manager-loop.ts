// Shared constants for the Meeting Manager loop marketplace bundle.
//
// The bundle contains the Meeting Manager, plus every trigger and skill
// attached to it. Like the Market & Competitor Watch bundle, its snapshot data
// is written to be workspace-neutral and lives in data/meeting-manager-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	MEETING_MANAGER_ACTOR,
	MEETING_MANAGER_LOOP_DESCRIPTION,
	MEETING_MANAGER_LOOP_NAME,
	MEETING_MANAGER_LOOP_SLUG,
	MEETING_MANAGER_LOOP_USE_CASE,
	MEETING_MANAGER_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export const MEETING_MANAGER_LOOP = {
	slug: MEETING_MANAGER_LOOP_SLUG,
	name: MEETING_MANAGER_LOOP_NAME,
	version: MEETING_MANAGER_LOOP_VERSION,
	useCase: MEETING_MANAGER_LOOP_USE_CASE,
	description: MEETING_MANAGER_LOOP_DESCRIPTION,
} as const

export const MEETING_MANAGER_ACTOR_IDS = [MEETING_MANAGER_ACTOR] as const

export const MEETING_MANAGER_TRIGGER_IDS: readonly string[] =
	MEETING_MANAGER_ACTOR_IDS.flatMap(triggerIdsForActor)

export const MEETING_MANAGER_SKILL_IDS: readonly string[] = [
	...new Set(MEETING_MANAGER_ACTOR_IDS.flatMap(skillIdsForActor)),
]
