// Shared constants for the Signal Intake flow marketplace bundle.
//
// The bundle contains the Signal Listener, plus every trigger and skill attached to it. Like the
// Competitor watch bundle, its snapshot data is written to be workspace-neutral and lives in
// data/signal-intake-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	SIGNAL_INTAKE_ACTOR_LISTENER,
	SIGNAL_INTAKE_LOOP_DESCRIPTION,
	SIGNAL_INTAKE_LOOP_NAME,
	SIGNAL_INTAKE_LOOP_SLUG,
	SIGNAL_INTAKE_LOOP_USE_CASE,
	SIGNAL_INTAKE_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// What the flow page shows beside the tabs. No targets ship: no trigger in the bundle keeps the
// actuals of a target current.
const SIGNAL_INTAKE_SETTINGS: LoopSettings = {
	entryCondition: 'A listening sweep or the monthly watchlist check fires on its schedule.',
	closeCondition:
		'Continuous. The flow never closes. Each sweep leaves the outside picture current.',
	tags: ['Discovery'],
}

export const SIGNAL_INTAKE_LOOP = {
	slug: SIGNAL_INTAKE_LOOP_SLUG,
	name: SIGNAL_INTAKE_LOOP_NAME,
	version: SIGNAL_INTAKE_LOOP_VERSION,
	useCase: SIGNAL_INTAKE_LOOP_USE_CASE,
	settings: SIGNAL_INTAKE_SETTINGS,
	description: SIGNAL_INTAKE_LOOP_DESCRIPTION,
} as const

export const SIGNAL_INTAKE_ACTOR_IDS = [SIGNAL_INTAKE_ACTOR_LISTENER] as const

export const SIGNAL_INTAKE_TRIGGER_IDS: readonly string[] =
	SIGNAL_INTAKE_ACTOR_IDS.flatMap(triggerIdsForActor)

export const SIGNAL_INTAKE_SKILL_IDS: readonly string[] = [
	...new Set(SIGNAL_INTAKE_ACTOR_IDS.flatMap(skillIdsForActor)),
]
