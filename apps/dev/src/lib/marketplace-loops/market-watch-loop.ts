// Shared constants for the Market & Competitor Watch loop marketplace bundle.
//
// The bundle contains the Market Researcher, Market Strategist and Briefing
// Owner, plus every trigger and skill attached to them. Unlike the bundles
// captured from a live workspace, its snapshot data is written to be
// workspace-neutral and lives in data/market-watch-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	MARKET_WATCH_ACTOR_OWNER,
	MARKET_WATCH_ACTOR_RESEARCHER,
	MARKET_WATCH_ACTOR_STRATEGIST,
	MARKET_WATCH_LOOP_DESCRIPTION,
	MARKET_WATCH_LOOP_NAME,
	MARKET_WATCH_LOOP_SLUG,
	MARKET_WATCH_LOOP_USE_CASE,
	MARKET_WATCH_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const MARKET_WATCH_LOOP = {
	slug: MARKET_WATCH_LOOP_SLUG,
	name: MARKET_WATCH_LOOP_NAME,
	version: MARKET_WATCH_LOOP_VERSION,
	useCase: MARKET_WATCH_LOOP_USE_CASE,
	description: MARKET_WATCH_LOOP_DESCRIPTION,
} as const

export const MARKET_WATCH_ACTOR_IDS = [
	MARKET_WATCH_ACTOR_RESEARCHER,
	MARKET_WATCH_ACTOR_STRATEGIST,
	MARKET_WATCH_ACTOR_OWNER,
] as const

export const MARKET_WATCH_TRIGGER_IDS: readonly string[] =
	MARKET_WATCH_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const MARKET_WATCH_SKILL_IDS: readonly string[] = [
	...new Set(MARKET_WATCH_ACTOR_IDS.flatMap(skillIdsForActor)),
]
