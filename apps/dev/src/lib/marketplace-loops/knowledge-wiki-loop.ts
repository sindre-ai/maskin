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
import type { LoopChecklist, LoopSettings } from './loop-settings'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

// What the flow page shows beside the tabs. The conditions are the live flow's, without
// anything specific to one workspace. Both targets ship because the weekly prune trigger
// recounts them under these exact labels and updates the numbers. The live flow's other
// targets (coverage grade, page completeness, pages validated) are left out: they are
// graded by hand against a bar that only the publisher's wiki has, and nothing in this
// bundle keeps their actuals current.
// The onboarding checklist install turns into tasks: one parent and one child per open
// prerequisite, all driven by the Curator. Wording is workspace-neutral. Each child says what is
// needed and tells the Curator to draft a best guess from what the workspace already holds, so the
// owner confirms or corrects instead of starting from a blank page.
const CHECKLIST_GUESS =
	'Draft your best guess from what the workspace already holds, put it in the task, and ask the owner to confirm or correct it.'

const KNOWLEDGE_WIKI_CHECKLIST: LoopChecklist = {
	title: 'Knowledge onboarding checklist',
	body: 'Everything the wiki needs to know before it can stay current. Each child task is one prerequisite. Work every open child until all are done or discarded, ask the owner at most 3 questions at a time, and report setup done only when every child is done or discarded.',
	driverSourceItemId: KNOWLEDGE_WIKI_ACTOR_CURATOR,
	items: [
		{
			title: 'Say who the main people are and what each is accountable for',
			body: `Needed: a name, a role and one line on what each main person is accountable for. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Name the function, mandate and decision makers',
			body: `Needed: what this team or function exists to do, what it may decide on its own, and who decides what. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Describe the company: legal entity, owners, size',
			body: `Needed: the legal entity, who owns it and how large it is (people and rough revenue band). ${CHECKLIST_GUESS}`,
		},
		{
			title: 'List products and pricing',
			body: `Needed: each product or service in one line, with its price or pricing model. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Name the ideal customers and top accounts',
			body: `Needed: who the ideal customer is and the top accounts today. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Name closest competitors and the market',
			body: `Needed: the closest competitors, the market the company sits in and how it differs from them. ${CHECKLIST_GUESS}`,
		},
		{
			title: "State this year's strategy, current projects and deadlines",
			body: `Needed: the strategy for this year, the projects running now and the deadlines that matter. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Add brand and voice with writing examples',
			body: `Needed: how the company sounds, words it uses and avoids, and two or three real writing examples. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Map the systems and sources the wiki can read',
			body: `Needed: the systems where knowledge lives (drives, mail, chat, trackers, code) and which of them the wiki may read. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Write down constraints: compliance, do-not-contact, approval rules, budget limits',
			body: `Needed: compliance rules, who must not be contacted, what needs a person's approval and any budget limits. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Connect at least one knowledge source (drive, mail, chat)',
			body: 'Needed: a person has to connect at least one source the wiki can read, such as a drive, a mailbox or a chat tool, in the workspace integration settings. Say which one is the best first source and why. Only a person can sign in, so ask the owner once and mark the task done when the connection shows as active.',
		},
	],
}

const KNOWLEDGE_WIKI_SETTINGS: LoopSettings = {
	checklist: KNOWLEDGE_WIKI_CHECKLIST,
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
