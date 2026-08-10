// Shared constants for the Gig Loop marketplace bundle.
//
// The bundle contains Gig Scout, Job Applicant, and Inbox Scout — scouts
// agency boards and the inbox for freelance/interim gigs, screens them
// against a fit bar, drafts applications from a shortlist, and sends only
// what has been explicitly approved. Sourced from a live solo-consultancy
// workspace.
//
// Deliberately excludes Knowledge Author, whose weekly gig-loop calibration
// trigger lives in the same source workspace (it rewrites the screening
// rubric from gig outcomes) — that actor belongs to its own knowledge/ops
// bundle, not this one, mirroring how the Growth workspace keeps Knowledge
// Author in "Ops & Knowledge Loop" rather than duplicating it into every
// domain loop that happens to read or write the wiki.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	CONSULTING_ACTOR_GIG_SCOUT,
	CONSULTING_ACTOR_INBOX_SCOUT,
	CONSULTING_ACTOR_JOB_APPLICANT,
	CONSULTING_LOOP_GIG_DESCRIPTION,
	CONSULTING_LOOP_GIG_NAME,
	CONSULTING_LOOP_GIG_SLUG,
	CONSULTING_LOOP_USE_CASE_CONSULTING,
	CONSULTING_SOURCE_WORKSPACE_ID,
	DEV_LOOP_VERSION,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const GIG_LOOP_SOURCE_WORKSPACE_ID = CONSULTING_SOURCE_WORKSPACE_ID

export const GIG_LOOP = {
	slug: CONSULTING_LOOP_GIG_SLUG,
	name: CONSULTING_LOOP_GIG_NAME,
	version: DEV_LOOP_VERSION,
	useCase: CONSULTING_LOOP_USE_CASE_CONSULTING,
	description: CONSULTING_LOOP_GIG_DESCRIPTION,
} as const

export const GIG_LOOP_ACTOR_IDS = [
	CONSULTING_ACTOR_GIG_SCOUT,
	CONSULTING_ACTOR_JOB_APPLICANT,
	CONSULTING_ACTOR_INBOX_SCOUT,
] as const

export const GIG_LOOP_TRIGGER_IDS: readonly string[] =
	GIG_LOOP_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const GIG_LOOP_SKILL_IDS: readonly string[] = [
	...new Set(GIG_LOOP_ACTOR_IDS.flatMap(skillIdsForActor)),
]
