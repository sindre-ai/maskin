// Shared constants for the Competitor watch loop marketplace bundle.
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
import type { LoopChecklist, LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// The research checklist install turns into tasks: one parent and one child per step of the
// competitor research method, all driven by the Market Researcher. Wording is workspace-neutral.
// The method itself lives in the researcher's instructions, so the children say what is needed
// and point at it. The refresh child maps to the monthly revalidation and adds no second schedule.
const METHOD_NOTE = 'Follow the competitor research method in your instructions.'

const MARKET_WATCH_CHECKLIST: LoopChecklist = {
	title: 'Competitor research checklist',
	body: 'Everything the flow needs to research competitors the same way every time. Each child task is one step of the competitor research method. Work every open child until all are done or discarded, ask the owner at most 3 questions at a time, and report setup done only when every child is done or discarded.',
	driverSourceItemId: MARKET_WATCH_ACTOR_RESEARCHER,
	items: [
		{
			title: 'Name 3 to 5 direct competitors',
			body: `Needed: 3 to 5 direct competitors. Research is always about their products, pricing and positioning. This one needs the owner: propose a best-guess list from what the workspace says about its own product and buyers, then ask the owner to confirm or correct it, at most 3 questions at a time. ${METHOD_NOTE}`,
		},
		{
			title: 'Use the same fields for each competitor',
			body: `Needed: the same five fields for every competitor: who they sell to, what the product does, pricing, how they sell, and how they position themselves. ${METHOD_NOTE}`,
		},
		{
			title: 'Check evidence, not claims',
			body: `Needed: evidence for each field from the live product, the changelog, the docs and job posts, plus customer reviews and complaints. A claim from a marketing page alone stays low confidence. ${METHOD_NOTE}`,
		},
		{
			title: 'Record source URLs for each competitor',
			body: `Needed: where each source lives so it can be rechecked: pricing page, changelog, docs, press or news page, blog, careers page, review profiles and social accounts. ${METHOD_NOTE}`,
		},
		{
			title: 'Add company register data and trends',
			body: `Needed: employee count, revenue, profit, equity, ownership and founding date for each competitor, from the Danish CVR register where the competitor is Danish and the local register elsewhere. Compare the last 2 to 3 years to see growth or shrinkage, note when each last filed, and mark each figure filed or estimated. ${METHOD_NOTE}`,
		},
		{
			title: 'Note gaps and edges',
			body: `Needed: for each competitor, what they do better than the workspace's own product, what they miss, and what their customers ask for. ${METHOD_NOTE}`,
		},
		{
			title: 'Write one page per competitor and a comparison table',
			body: `Needed: one page per competitor and one comparison table across all of them. Every claim has a date and a source, and a claim with no source does not go in. ${METHOD_NOTE}`,
		},
		{
			title: 'Refresh sources and register data on schedule',
			body: 'Needed: the recorded source URLs and the register data re-run on a set schedule. That schedule is the existing Monthly revalidation trigger of this flow, so do not add a second one. Mark this task done once the first monthly revalidation has re-run them, or once you have confirmed the Monthly revalidation trigger is enabled.',
		},
	],
}

// What the flow page shows beside the tabs. No targets ship: the flow watches continuously, so
// there is no number for its agents to keep current.
const MARKET_WATCH_SETTINGS: LoopSettings = {
	checklist: MARKET_WATCH_CHECKLIST,
	entryCondition: 'The weekly sweep or the monthly revalidation fires on its schedule.',
	closeCondition:
		'The flow keeps watching and has no end state. An insight is done once it is routed: clustered, scored, parked with a reason or discarded. Each sweep leaves the competitor and category picture current.',
	tags: ['Market'],
}

export const MARKET_WATCH_LOOP = {
	slug: MARKET_WATCH_LOOP_SLUG,
	name: MARKET_WATCH_LOOP_NAME,
	version: MARKET_WATCH_LOOP_VERSION,
	useCase: MARKET_WATCH_LOOP_USE_CASE,
	settings: MARKET_WATCH_SETTINGS,
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
