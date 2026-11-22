// Shared constants for the Accounting marketplace bundle (slug accounting-loop).
//
// The bundle contains the Bookkeeper, plus every trigger and skill attached to it. Its snapshot
// data is written to be workspace-neutral and lives in data/accounting-*.json. The Dinero
// connection is not shipped: the installer adds Dinero's own server as a custom tool after
// install, by the steps in the accounting-connection-check skill.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	ACCOUNTING_LOOP_ACTOR_BOOKKEEPER,
	ACCOUNTING_LOOP_DESCRIPTION,
	ACCOUNTING_LOOP_NAME,
	ACCOUNTING_LOOP_SLUG,
	ACCOUNTING_LOOP_USE_CASE,
	ACCOUNTING_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

// What the flow page shows beside the tabs. No targets ship: no bundled trigger keeps a target's
// actual current under a fixed label.
const ACCOUNTING_LOOP_SETTINGS: LoopSettings = {
	entryCondition:
		"A person uploads a receipt, a photo or a PDF, in the flow's chat, and Dinero is connected.",
	closeCondition:
		'The receipt is saved as a draft voucher in Dinero, or it is on the adviser list with the reason. Nothing is booked, changed or deleted by the flow.',
	tags: ['Finance'],
}

export const ACCOUNTING_LOOP = {
	slug: ACCOUNTING_LOOP_SLUG,
	name: ACCOUNTING_LOOP_NAME,
	version: ACCOUNTING_LOOP_VERSION,
	useCase: ACCOUNTING_LOOP_USE_CASE,
	settings: ACCOUNTING_LOOP_SETTINGS,
	description: ACCOUNTING_LOOP_DESCRIPTION,
} as const

export const ACCOUNTING_LOOP_ACTOR_IDS = [ACCOUNTING_LOOP_ACTOR_BOOKKEEPER] as const

export const ACCOUNTING_LOOP_TRIGGER_IDS: readonly string[] =
	ACCOUNTING_LOOP_ACTOR_IDS.flatMap(triggerIdsForActor)

export const ACCOUNTING_LOOP_SKILL_IDS: readonly string[] = [
	...new Set(ACCOUNTING_LOOP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
