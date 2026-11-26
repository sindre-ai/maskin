// Shared constants for the Workspace improvements flow marketplace bundle.
//
// The bundle ships no agent. Its triggers and skills name the Workspace Coach and the Chief of
// Staff by role, and install binds them to the agents every workspace already has (see
// resolveRoleActors in services/loop-provisioning). Neither agent's prompt is part of the bundle, so
// a locked install can never overwrite the default chat agent. Snapshot data is written to be
// workspace-neutral and lives in data/workspace-improvements-*.json.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	WORKSPACE_IMPROVEMENTS_LOOP_DESCRIPTION,
	WORKSPACE_IMPROVEMENTS_LOOP_NAME,
	WORKSPACE_IMPROVEMENTS_LOOP_SLUG,
	WORKSPACE_IMPROVEMENTS_LOOP_USE_CASE,
	WORKSPACE_IMPROVEMENTS_LOOP_VERSION,
	WORKSPACE_IMPROVEMENTS_ROLE_CHIEF_OF_STAFF,
	WORKSPACE_IMPROVEMENTS_ROLE_COACH,
} from '@maskin/shared'
import workspaceImprovementsViewsData from './data/workspace-improvements-views.json'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'
import type { LoopChecklist, LoopSettings } from './loop-settings'

// The onboarding checklist install turns into tasks: one parent and one child per open
// prerequisite, all driven by the Chief of Staff. Each child says what is needed and tells the
// driver to draft a best guess from what the workspace already holds, so the owner confirms or
// corrects instead of starting from a blank page.
const CHECKLIST_GUESS =
	'Draft your best guess from what the workspace already holds, put it in the task, and ask the owner to confirm or correct it.'

const WORKSPACE_IMPROVEMENTS_CHECKLIST: LoopChecklist = {
	title: 'Workspace improvements onboarding checklist',
	body: 'Everything this flow needs before the Workspace Coach can coach well. Each child task is one prerequisite. Work every open child until all are done or discarded, ask the owner at most 3 questions at a time, and report setup done only when every child is done or discarded.',
	driverSourceItemId: WORKSPACE_IMPROVEMENTS_ROLE_CHIEF_OF_STAFF,
	items: [
		{
			title: "Check the Coach's first sweep ran",
			body: 'Needed: proof that the Workspace Coach sweep has run at least once and could read agent sessions, flows, triggers and recent comments. If it has not run, say when it is next due. If it failed, say why and fix what you own.',
		},
		{
			title: 'Name who reviews the recommendations',
			body: `Needed: the person who decides on the Coach's recommendations, and how they like to be reached. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'List agents and flows the sweep should skip',
			body: `Needed: any agent or flow that is still in a trial or being rebuilt, so the Coach does not file findings on it yet. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Set what counts as wasted spend',
			body: `Needed: a session cost or session count per agent per week above which the Coach should flag waste, in plain numbers. ${CHECKLIST_GUESS}`,
		},
		{
			title: 'Take the first reading of both targets',
			body: 'Needed: a real first reading of Insight backlog and Orphaned insights on the flow, counted the way the owner heartbeat counts them, with the source line filled in.',
		},
		{
			title: 'Check the Results tab loads',
			body: 'Needed: open the Results tab and confirm its counters load. If they show an error, fix the page. Say what the first weekly read will bring forward.',
		},
	],
}

// What the flow page shows beside the tabs. The conditions are the live flow's. Both targets ship
// because the owner heartbeat recounts them under these exact labels on every run. The live
// flow's third target (Insight inflow) is left out: nothing in this bundle recounts it.
const WORKSPACE_IMPROVEMENTS_SETTINGS: LoopSettings = {
	checklist: WORKSPACE_IMPROVEMENTS_CHECKLIST,
	adoptExisting: true,
	// The hand-made flow's own triggers this bundle replaces: the sweep (with the clustering and the
	// outcome steps now folded in) and the owner heartbeat. Any other trigger on it keeps running.
	replacesTriggerNames: [
		'Workspace Coach — daily sweep',
		'Cluster & recommend',
		'Capture outcome',
		'Owner heartbeat (daily, permanent)',
	],
	entryCondition:
		'An insight is created with title starting `[workspace-improvements]` (status=new).',
	closeCondition: 'The insight reaches status scored, parked, or discarded.',
	targets: [
		{
			label: 'Insight backlog',
			source:
				'In-progress insights on this flow (members only), recounted by the owner heartbeat. The goal is a ceiling of 30. Not counted yet.',
			actual: 0,
			target: 30,
		},
		{
			label: 'Orphaned insights',
			source:
				'Open member insights naming an agent that cannot act on them, recounted by the owner heartbeat. The goal is zero. Not counted yet.',
			actual: 0,
			target: 0,
		},
	],
}

export const WORKSPACE_IMPROVEMENTS_LOOP = {
	slug: WORKSPACE_IMPROVEMENTS_LOOP_SLUG,
	name: WORKSPACE_IMPROVEMENTS_LOOP_NAME,
	version: WORKSPACE_IMPROVEMENTS_LOOP_VERSION,
	useCase: WORKSPACE_IMPROVEMENTS_LOOP_USE_CASE,
	settings: WORKSPACE_IMPROVEMENTS_SETTINGS,
	description: WORKSPACE_IMPROVEMENTS_LOOP_DESCRIPTION,
} as const

/** The bundle ships no agents of its own. */
export const WORKSPACE_IMPROVEMENTS_ACTOR_IDS: readonly string[] = []

/** Roles the bundle's triggers and skills name, bound to the workspace's own agents at install. */
export const WORKSPACE_IMPROVEMENTS_ROLE_IDS = [
	WORKSPACE_IMPROVEMENTS_ROLE_COACH,
	WORKSPACE_IMPROVEMENTS_ROLE_CHIEF_OF_STAFF,
] as const

export const WORKSPACE_IMPROVEMENTS_TRIGGER_IDS: readonly string[] =
	WORKSPACE_IMPROVEMENTS_ROLE_IDS.flatMap(triggerIdsForActor)

export const WORKSPACE_IMPROVEMENTS_SKILL_IDS: readonly string[] = [
	...new Set(WORKSPACE_IMPROVEMENTS_ROLE_IDS.flatMap(skillIdsForActor)),
]

// The flow page's tabs, in order: a starter Results page that shows live counters and fills in
// when the owner refreshes it on Monday.
export const WORKSPACE_IMPROVEMENTS_VIEW_IDS: readonly string[] = Object.values(
	workspaceImprovementsViewsData,
)
	.sort((a, b) => a.position - b.position)
	.map((view) => view.id)
