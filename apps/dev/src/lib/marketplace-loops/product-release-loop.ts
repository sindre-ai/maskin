// Shared constants for the Product release marketplace bundle.
//
// The bundle contains the Release Manager and the optional Store Release Manager,
// plus every trigger and skill attached to them. Like the Market & Competitor Watch
// bundle, its snapshot data is written to be workspace-neutral and lives in
// data/product-release-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	PRODUCT_RELEASE_ACTOR_MANAGER,
	PRODUCT_RELEASE_ACTOR_STORE,
	PRODUCT_RELEASE_LOOP_DESCRIPTION,
	PRODUCT_RELEASE_LOOP_NAME,
	PRODUCT_RELEASE_LOOP_SLUG,
	PRODUCT_RELEASE_LOOP_USE_CASE,
	PRODUCT_RELEASE_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

// What the flow page shows beside the tabs. No targets ship: the live flow's targets are tied to
// one team's store timings, and no bundled trigger keeps an actual current under a shared label.
const PRODUCT_RELEASE_SETTINGS: LoopSettings = {
	entryCondition: 'A user-facing change has merged since the last release.',
	closeCondition:
		'The release is live on every surface it covers and its change log is written. For a notable release, the update text, the in-app note and the public log entry are also live and read back.',
	tags: ['Delivery'],
}

export const PRODUCT_RELEASE_LOOP = {
	slug: PRODUCT_RELEASE_LOOP_SLUG,
	name: PRODUCT_RELEASE_LOOP_NAME,
	version: PRODUCT_RELEASE_LOOP_VERSION,
	useCase: PRODUCT_RELEASE_LOOP_USE_CASE,
	settings: PRODUCT_RELEASE_SETTINGS,
	description: PRODUCT_RELEASE_LOOP_DESCRIPTION,
} as const

export const PRODUCT_RELEASE_ACTOR_IDS = [
	PRODUCT_RELEASE_ACTOR_MANAGER,
	PRODUCT_RELEASE_ACTOR_STORE,
] as const

export const PRODUCT_RELEASE_TRIGGER_IDS: readonly string[] =
	PRODUCT_RELEASE_ACTOR_IDS.flatMap(triggerIdsForActor)

// The skill is attached to both actors, so dedupe it to publish it once.
export const PRODUCT_RELEASE_SKILL_IDS: readonly string[] = [
	...new Set(PRODUCT_RELEASE_ACTOR_IDS.flatMap(skillIdsForActor)),
]
