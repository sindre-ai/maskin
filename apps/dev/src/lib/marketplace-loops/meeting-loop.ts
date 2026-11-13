// Shared constants for the Meeting Loop marketplace bundle.
//
// The bundle contains the Meeting Manager, plus every trigger and skill
// attached to it. Like the Market & Competitor Watch bundle, its snapshot data
// is written to be workspace-neutral and lives in data/meeting-loop-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	MEETING_LOOP_ACTOR_MEETING_MANAGER,
	MEETING_LOOP_DESCRIPTION,
	MEETING_LOOP_NAME,
	MEETING_LOOP_SLUG,
	MEETING_LOOP_USE_CASE,
	MEETING_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export const MEETING_LOOP = {
	slug: MEETING_LOOP_SLUG,
	name: MEETING_LOOP_NAME,
	version: MEETING_LOOP_VERSION,
	useCase: MEETING_LOOP_USE_CASE,
	description: MEETING_LOOP_DESCRIPTION,
} as const

export const MEETING_LOOP_ACTOR_IDS = [MEETING_LOOP_ACTOR_MEETING_MANAGER] as const

export const MEETING_LOOP_TRIGGER_IDS: readonly string[] =
	MEETING_LOOP_ACTOR_IDS.flatMap(triggerIdsForActor)

export const MEETING_LOOP_SKILL_IDS: readonly string[] = [
	...new Set(MEETING_LOOP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
