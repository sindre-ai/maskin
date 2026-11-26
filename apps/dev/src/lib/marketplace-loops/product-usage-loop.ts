// Shared constants for the Product Analytics marketplace bundle (slug product-usage-loop).
//
// The bundle contains the Product Analyst, its three triggers (the Monday read, the daily
// anomaly check and the owner heartbeat), the two skills it loads and starter Results and
// Lifecycle tabs. The flow description carries an empty Setup section the installer fills.
// Its data in data/product-usage-*.json is written to be workspace-neutral:
// it names no company, person, product, date or id, and it works with
// whichever product analytics tool the installer connects. With none
// connected, the Monday read says so once and stops.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	PRODUCT_USAGE_ACTOR_ANALYST,
	PRODUCT_USAGE_LOOP_DESCRIPTION,
	PRODUCT_USAGE_LOOP_NAME,
	PRODUCT_USAGE_LOOP_SLUG,
	PRODUCT_USAGE_LOOP_USE_CASE,
	PRODUCT_USAGE_LOOP_VERSION,
} from '@maskin/shared'
import productUsageViewsData from './data/product-usage-views.json'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// What the flow page shows beside the tabs. One target ships: the owner heartbeat keeps the
// actual of "Usage reads" current.
const PRODUCT_USAGE_SETTINGS: LoopSettings = {
	entryCondition:
		'The weekly read or the daily check finds a change, an anomaly, or a number that contradicts what the team believes.',
	closeCondition:
		'A finding is done when it is filed once as an insight with a recommended action, linked to the feature or bet it concerns, and, if critical, the person named in Setup has been notified. A read with nothing new counts as done and stays silent. With no product analytics tool connected the flow only says so, once.',
	tags: ['Product'],
	targets: [
		{
			label: 'Usage reads',
			source:
				'Manual. Weekly reads completed this week. The Monday read and the owner heartbeat keep it current.',
			actual: 0,
			target: 1,
			pace_policy: 'window',
		},
	],
}

export const PRODUCT_USAGE_LOOP = {
	slug: PRODUCT_USAGE_LOOP_SLUG,
	name: PRODUCT_USAGE_LOOP_NAME,
	version: PRODUCT_USAGE_LOOP_VERSION,
	useCase: PRODUCT_USAGE_LOOP_USE_CASE,
	settings: PRODUCT_USAGE_SETTINGS,
	description: PRODUCT_USAGE_LOOP_DESCRIPTION,
} as const

export const PRODUCT_USAGE_ACTOR_IDS = [PRODUCT_USAGE_ACTOR_ANALYST] as const

export const PRODUCT_USAGE_TRIGGER_IDS: readonly string[] =
	PRODUCT_USAGE_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors, so dedupe it: it is
// published once instead of colliding on the (loopId, itemType, sourceItemId) uniqueness
// the install path relies on.
export const PRODUCT_USAGE_SKILL_IDS: readonly string[] = [
	...new Set(PRODUCT_USAGE_ACTOR_IDS.flatMap(skillIdsForActor)),
]

// The flow page's tabs, in order. Results and Lifecycle ship as starter pages in the quiet state;
// their counters read live and show zero in an empty workspace. See data/product-usage-views.json.
export const PRODUCT_USAGE_VIEW_IDS: readonly string[] = Object.values(productUsageViewsData)
	.sort((a, b) => a.position - b.position)
	.map((view) => view.id)
