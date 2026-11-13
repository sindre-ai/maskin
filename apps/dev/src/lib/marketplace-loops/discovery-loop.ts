// Shared constants for the Product Discovery Loop marketplace bundle.
//
// The bundle contains the Product Discovery Agent, the CPO and the Strategist,
// plus every trigger they drive: triage of new insights, an insight synthesis
// sweep, a backlog drain, a weekly briefing, weekly and daily upkeep of the
// Discovery understanding and Bet intelligence pages, the evidence base and
// strategy check pages, the CPO's critique and grading pass, review of
// opportunity bets, and shaping once a person moves a bet to define.
//
// The workspace's coordinator (the Chief of Staff every workspace is seeded
// with) is deliberately not in the bundle. Its attention trigger and the loop
// owner heartbeat are left out; the agents here find the coordinator by role.
//
// The prompts, trigger prompts and skills in data/discovery-*.json are the real
// ones from a working workspace, with everything specific to that company, its
// people, dates and ids stripped, so they carry no company, person, date or id.
// Ids below are template ids that only exist for the install path's
// source_item_id wiring.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT = '508ecfdc-c0fa-4103-ae54-e4ce678b364d'
export const DISCOVERY_ACTOR_CPO = 'f5bfd2f0-bdce-496b-9ab7-d181496b3101'
export const DISCOVERY_ACTOR_STRATEGIST = '02f60f27-615a-4cdd-9af0-23f402f067e4'

export const DISCOVERY_LOOP = {
	slug: 'product-discovery-loop',
	name: 'Product Discovery Loop',
	version: '1.2.0',
	useCase: 'Discovery',
	description:
		'Turns a steady stream of customer, prospect and market feedback into a short, ranked list of opportunities backed by evidence. New feedback is triaged as it arrives and clustered into candidate bets that state the problem, who has it, the evidence for and against, and the riskiest unknown. Weak candidates are paused on a rolling schedule, two living pages (what we understand about customers, and what it means for each bet) are kept current and graded each week, a plain-words weekly briefing says what was learned and what is worth a look, and people decide which opportunities move on to shaping. Works with whatever sources you connect, such as product analytics, meeting transcripts or team chat.',
} as const

export const DISCOVERY_ACTOR_IDS = [
	DISCOVERY_ACTOR_PRODUCT_DISCOVERY_AGENT,
	DISCOVERY_ACTOR_CPO,
	DISCOVERY_ACTOR_STRATEGIST,
] as const

export const DISCOVERY_TRIGGER_IDS: readonly string[] =
	DISCOVERY_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors, so dedupe
// it: it is published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const DISCOVERY_SKILL_IDS: readonly string[] = [
	...new Set(DISCOVERY_ACTOR_IDS.flatMap(skillIdsForActor)),
]
