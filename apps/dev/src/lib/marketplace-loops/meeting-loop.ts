// Shared constants for the Meeting insights marketplace bundle (slug meeting-loop).
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
import type { LoopSettings } from './loop-settings'

// What the flow page shows beside the tabs. No targets ship: no bundled trigger keeps a target's
// actual current under a fixed label.
const MEETING_LOOP_SETTINGS: LoopSettings = {
	entryCondition:
		"A meeting ends or is scheduled, with a Google Meet transcript, a notetaker transcript or a person's written reflection.",
	closeCondition:
		'The meeting is processed: one meeting object holds the analysis, attendees are linked, insights and tasks are filed, and every commitment is done or has a dated owner. A meeting with no recording stays at happened, with that said in its body.',
	tags: ['Context'],
}

export const MEETING_LOOP = {
	slug: MEETING_LOOP_SLUG,
	name: MEETING_LOOP_NAME,
	version: MEETING_LOOP_VERSION,
	useCase: MEETING_LOOP_USE_CASE,
	settings: MEETING_LOOP_SETTINGS,
	description: MEETING_LOOP_DESCRIPTION,
} as const

export const MEETING_LOOP_ACTOR_IDS = [MEETING_LOOP_ACTOR_MEETING_MANAGER] as const

export const MEETING_LOOP_TRIGGER_IDS: readonly string[] =
	MEETING_LOOP_ACTOR_IDS.flatMap(triggerIdsForActor)

export const MEETING_LOOP_SKILL_IDS: readonly string[] = [
	...new Set(MEETING_LOOP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
