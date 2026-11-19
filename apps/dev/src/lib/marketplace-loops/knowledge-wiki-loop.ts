// Shared constants for the Knowledge Wiki flow marketplace bundle.
//
// The bundle contains the Knowledge Curator, plus every trigger and skill
// attached to it: a fold-in on every new knowledge page, a twice-weekly digest,
// a daily owner heartbeat and a weekly prune. Like the Market & Competitor Watch
// bundle, its snapshot data is written to be workspace-neutral and lives in
// data/knowledge-wiki-*.json.
//
// The live flow's other agents are not in the bundle. Wiki Home, Wiki Status and
// the coverage bar are found by title or created on the first digest, never by
// id, and owners are found by role.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	KNOWLEDGE_WIKI_ACTOR_CURATOR,
	KNOWLEDGE_WIKI_LOOP_DESCRIPTION,
	KNOWLEDGE_WIKI_LOOP_NAME,
	KNOWLEDGE_WIKI_LOOP_SLUG,
	KNOWLEDGE_WIKI_LOOP_USE_CASE,
	KNOWLEDGE_WIKI_LOOP_VERSION,
} from '@maskin/shared'
import knowledgeWikiViewsData from './data/knowledge-wiki-views.json'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// What the flow page shows beside the tabs. The conditions are the live flow's, without
// anything specific to one workspace. Both targets ship because the weekly prune trigger
// recounts them under these exact labels and updates the numbers. The live flow's other
// targets (coverage grade, page completeness, pages validated) are left out: they are
// graded by hand against a bar that only the publisher's wiki has, and nothing in this
// bundle keeps their actuals current.
const KNOWLEDGE_WIKI_SETTINGS: LoopSettings = {
	entryCondition: 'A knowledge page is created, or the twice-weekly digest is due.',
	closeCondition:
		'Each pass ends with the digest posted and Wiki Home and Wiki Status refreshed. The flow does not close; it keeps the wiki current.',
	tags: ['Context'],
	targets: [
		{
			label: 'Idle drafts',
			source:
				'Draft knowledge pages not edited in 14 days, recounted by the weekly prune sweep. The goal is zero. Not counted yet.',
			actual: 0,
			target: 0,
		},
		{
			label: 'Stale pages',
			source:
				'Validated knowledge pages not edited in 60 days, recounted by the weekly prune sweep. The goal is zero. Not counted yet.',
			actual: 0,
			target: 0,
		},
	],
}

export const KNOWLEDGE_WIKI_LOOP = {
	slug: KNOWLEDGE_WIKI_LOOP_SLUG,
	name: KNOWLEDGE_WIKI_LOOP_NAME,
	version: KNOWLEDGE_WIKI_LOOP_VERSION,
	useCase: KNOWLEDGE_WIKI_LOOP_USE_CASE,
	settings: KNOWLEDGE_WIKI_SETTINGS,
	description: KNOWLEDGE_WIKI_LOOP_DESCRIPTION,
} as const

export const KNOWLEDGE_WIKI_ACTOR_IDS = [KNOWLEDGE_WIKI_ACTOR_CURATOR] as const

export const KNOWLEDGE_WIKI_TRIGGER_IDS: readonly string[] =
	KNOWLEDGE_WIKI_ACTOR_IDS.flatMap(triggerIdsForActor)

export const KNOWLEDGE_WIKI_SKILL_IDS: readonly string[] = [
	...new Set(KNOWLEDGE_WIKI_ACTOR_IDS.flatMap(skillIdsForActor)),
]

// The flow page's tabs, in order. Both read live counts and show zeros in an empty
// workspace; the findings on them are written by the Curator each Monday.
export const KNOWLEDGE_WIKI_VIEW_IDS: readonly string[] = Object.values(knowledgeWikiViewsData)
	.sort((a, b) => a.position - b.position)
	.map((view) => view.id)
