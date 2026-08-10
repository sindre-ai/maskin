// Shared constants for the Gig Loop marketplace bundle.
//
// The bundle contains Gig Scout, Job Applicant, and Inbox Scout — scouts
// agency boards and the inbox for freelance/interim gigs, screens them
// against a fit bar, drafts applications from a shortlist, and sends only
// what has been explicitly approved. Sourced from the live Mesh Firm
// workspace (369d2e23-d76c-4c71-807e-ab1698f18b1c).
//
// Deliberately excludes Knowledge Author, whose weekly gig-loop calibration
// trigger lives in Mesh Firm too (it rewrites the screening rubric from gig
// outcomes) — that actor belongs to its own knowledge/ops bundle, not this
// one, mirroring how the Growth workspace keeps Knowledge Author in
// "Ops & Knowledge Loop" rather than duplicating it into every domain loop
// that happens to read or write the wiki.
//
// Exported so the seed config and its tests can share the exact same shape.
// Snapshot helpers live in ./loop-snapshot; snapshot data in ./loop-data.

import {
	DEV_LOOP_VERSION,
	MESH_FIRM_ACTOR_GIG_SCOUT,
	MESH_FIRM_ACTOR_INBOX_SCOUT,
	MESH_FIRM_ACTOR_JOB_APPLICANT,
	MESH_FIRM_LOOP_GIG_DESCRIPTION,
	MESH_FIRM_LOOP_GIG_NAME,
	MESH_FIRM_LOOP_GIG_SLUG,
	MESH_FIRM_LOOP_USE_CASE_CONSULTING,
	MESH_FIRM_SOURCE_WORKSPACE_ID,
} from '@maskin/shared'
import { skillIdsForActor, triggerIdsForActor } from './loop-data'

export { actorSnapshot, skillSnapshot, triggerSnapshot } from './loop-snapshot'

export const MESH_FIRM_GIG_SOURCE_WORKSPACE_ID = MESH_FIRM_SOURCE_WORKSPACE_ID

export const MESH_FIRM_GIG_LOOP = {
	slug: MESH_FIRM_LOOP_GIG_SLUG,
	name: MESH_FIRM_LOOP_GIG_NAME,
	version: DEV_LOOP_VERSION,
	useCase: MESH_FIRM_LOOP_USE_CASE_CONSULTING,
	description: MESH_FIRM_LOOP_GIG_DESCRIPTION,
} as const

export const MESH_FIRM_GIG_ACTOR_IDS = [
	MESH_FIRM_ACTOR_GIG_SCOUT,
	MESH_FIRM_ACTOR_JOB_APPLICANT,
	MESH_FIRM_ACTOR_INBOX_SCOUT,
] as const

export const MESH_FIRM_GIG_TRIGGER_IDS: readonly string[] =
	MESH_FIRM_GIG_ACTOR_IDS.flatMap(triggerIdsForActor)

// A skill can be attached to more than one of the bundle's actors — dedupe so
// it's only published once instead of colliding on the (loopId, itemType,
// sourceItemId) uniqueness the install path relies on.
export const MESH_FIRM_GIG_SKILL_IDS: readonly string[] = [
	...new Set(MESH_FIRM_GIG_ACTOR_IDS.flatMap(skillIdsForActor)),
]
