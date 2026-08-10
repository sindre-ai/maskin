// Canonical source-item IDs for the Mesh Firm workspace marketplace loops.
// These are the IDs of the actors in Maskin's live Mesh Firm workspace
// (369d2e23-d76c-4c71-807e-ab1698f18b1c) — a solo consultancy workspace. All
// loop configs import from here so each actor ID is only written in one
// place. Trigger IDs are not listed as constants — they're derived per-actor
// via `triggerIdsForActor` in ./marketplace-loops/loop-data (mirrors the
// growth-workspace-loops.ts pattern).

// ── Source workspace ─────────────────────────────────────────────────────────

export const MESH_FIRM_SOURCE_WORKSPACE_ID = '369d2e23-d76c-4c71-807e-ab1698f18b1c'

// ── Actor IDs ────────────────────────────────────────────────────────────────

export const MESH_FIRM_ACTOR_GIG_SCOUT = 'f64a5297-b422-4e35-a99d-9ec17526bc04'
export const MESH_FIRM_ACTOR_JOB_APPLICANT = '60e39163-ea7d-4774-b87b-a9158d55481e'
export const MESH_FIRM_ACTOR_INBOX_SCOUT = 'cd359acc-0ba1-40c4-823d-0704212385b5'

// ── Use cases ────────────────────────────────────────────────────────────────
// 'Consulting' is new — the marketplace derives its use-case filter chips from
// whatever distinct values are present in the marketplace, so no other
// registration is required.

export const MESH_FIRM_LOOP_USE_CASE_CONSULTING = 'Consulting'

// ── Gig Loop ─────────────────────────────────────────────────────────────────
// Gig Scout, Job Applicant, Inbox Scout — scouts agency boards and the inbox
// for freelance/interim gigs, screens them against a fit bar, drafts
// applications from a shortlist, and sends only what has been approved.

export const MESH_FIRM_LOOP_GIG_SLUG = 'gig-loop'
export const MESH_FIRM_LOOP_GIG_NAME = 'Gig Loop'
export const MESH_FIRM_LOOP_GIG_DESCRIPTION =
	'Scouts agency boards and inbox for freelance and interim gigs, screens them against a fit bar, drafts applications from a shortlist, and sends only what has been explicitly approved.'
