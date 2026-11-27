// Shared constants for the Product Delivery marketplace bundle.
//
// The bundle contains the Delivery Lead, Developer, Reviewer and Coordinator, plus every trigger and
// skill attached to them. Its snapshot data is written to be workspace-neutral and lives in
// data/product-delivery-*.json. Agents are reached by role, never by name or id.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	PRODUCT_DELIVERY_ACTOR_COORDINATOR,
	PRODUCT_DELIVERY_ACTOR_DEVELOPER,
	PRODUCT_DELIVERY_ACTOR_LEAD,
	PRODUCT_DELIVERY_ACTOR_REVIEWER,
	PRODUCT_DELIVERY_LOOP_DESCRIPTION,
	PRODUCT_DELIVERY_LOOP_NAME,
	PRODUCT_DELIVERY_LOOP_SLUG,
	PRODUCT_DELIVERY_LOOP_USE_CASE,
	PRODUCT_DELIVERY_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

// What the flow page shows beside the tabs. No targets ship: the live flow's targets are typed by
// hand with one team's owners and sources, and no bundled trigger keeps an actual current under a
// shared label.
const PRODUCT_DELIVERY_SETTINGS: LoopSettings = {
	entryCondition:
		'A bet moves to define or to active, or a task under an active bet is ready to build.',
	closeCondition:
		'The bet is built and shipped: it reaches live and the delivery lead has posted the evidence call. A bet that is archived or paused also leaves the flow.',
	tags: ['Delivery'],
}

export const PRODUCT_DELIVERY_LOOP = {
	slug: PRODUCT_DELIVERY_LOOP_SLUG,
	name: PRODUCT_DELIVERY_LOOP_NAME,
	version: PRODUCT_DELIVERY_LOOP_VERSION,
	useCase: PRODUCT_DELIVERY_LOOP_USE_CASE,
	settings: PRODUCT_DELIVERY_SETTINGS,
	description: PRODUCT_DELIVERY_LOOP_DESCRIPTION,
} as const

export const PRODUCT_DELIVERY_ACTOR_IDS = [
	PRODUCT_DELIVERY_ACTOR_LEAD,
	PRODUCT_DELIVERY_ACTOR_DEVELOPER,
	PRODUCT_DELIVERY_ACTOR_REVIEWER,
	PRODUCT_DELIVERY_ACTOR_COORDINATOR,
] as const

export const PRODUCT_DELIVERY_TRIGGER_IDS: readonly string[] =
	PRODUCT_DELIVERY_ACTOR_IDS.flatMap(triggerIdsForActor)

// Skills are attached to several actors, so dedupe each to publish it once.
export const PRODUCT_DELIVERY_SKILL_IDS: readonly string[] = [
	...new Set(PRODUCT_DELIVERY_ACTOR_IDS.flatMap(skillIdsForActor)),
]
