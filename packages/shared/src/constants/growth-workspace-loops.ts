// Canonical source-item IDs for the Growth Workspace marketplace loops.
// These are the IDs of the actors in Maskin's live Growth workspace
// (2b95807b-26f8-424c-8e35-8bee8ed57f7d). All loop configs import from here
// so each actor ID is only written in one place. Trigger and skill IDs are not
// listed as constants — they're derived per-actor via `triggerIdsForActor` /
// `skillIdsForActor` in ./marketplace-loops/loop-data (mirrors the
// dev-workspace-loops.ts pattern).

// ── Source workspace ─────────────────────────────────────────────────────────

export const GROWTH_SOURCE_WORKSPACE_ID = '2b95807b-26f8-424c-8e35-8bee8ed57f7d'

// ── Actor IDs ────────────────────────────────────────────────────────────────

export const GROWTH_ACTOR_PROSPECTOR = '718b7634-12b8-4948-b414-04f70b2dd179'
export const GROWTH_ACTOR_QUALIFIER = 'cbaebf86-2963-47d7-98bd-752e5824e7c9'
export const GROWTH_ACTOR_HUBSPOT_LIAISON = '41733775-afc4-4fa6-8944-e1257daaf0b0'
export const GROWTH_ACTOR_SALES_REP = '9d524e03-37a8-47aa-a49c-019ff2ae99c2'
export const GROWTH_ACTOR_SALES_REP_MAGNUS = '892c231b-1507-44d5-8de7-c4f2d3c4cbd3'
export const GROWTH_ACTOR_RUNE_VAERK = 'b26eb652-6256-4848-94cc-205f07f7f346'
export const GROWTH_ACTOR_SALES_COACH = 'f1c28aee-0fdb-45f5-a2ed-d7ef64964164'
export const GROWTH_ACTOR_DEAL_CLOSER = '7a7ed101-57d0-45af-8203-0bcdb4bcc2b1'
export const GROWTH_ACTOR_RELATIONSHIP_WARMER = 'b476c898-18d7-4fb7-9386-757d03ce1bd4'
export const GROWTH_ACTOR_SALESOPS = '09a82385-614e-4059-939f-d7f1406ef0bd'
export const GROWTH_ACTOR_CONTENT_WRITER = 'd7f5898e-518a-45f8-abfe-42ef7994736d'
export const GROWTH_ACTOR_INSIGHT_HARVESTER = 'ac1d6ea7-3caf-42f4-bab9-5073bd85a79c'
export const GROWTH_ACTOR_INSIGHTS_SYNTHESIZER = 'b1634f4a-91ea-45d2-8203-f59ecbeb8e12'
export const GROWTH_ACTOR_INFLUENCER_MANAGER = '4bd39255-01a8-4cb6-b3ba-0edb3df91837'
export const GROWTH_ACTOR_DEMO_VIDEO_PRODUCER = 'a7603bf0-4a6a-4f54-8c4d-27500d8b8860'
export const GROWTH_ACTOR_VISUAL_DESIGNER = '90c29548-9241-4719-9239-40541590cef0'
export const GROWTH_ACTOR_SEARCH_AI_VISIBILITY_ANALYST = 'df5d060f-0d63-4824-b7bb-c29892b5b8fd'
export const GROWTH_ACTOR_EVENT_PRODUCER = '15e3fa01-af2d-4bde-baf4-8dd52bda9dd2'
export const GROWTH_ACTOR_GROWTH_STRATEGIST = '6dde676c-8c2a-4e57-be2a-6da8cb7f316b'
export const GROWTH_ACTOR_GROWTH_MANAGER = '7ae3408e-3155-44d7-afdb-507c84dd54db'
export const GROWTH_ACTOR_GROWTH_IDEATOR = 'b7a775eb-8e30-492d-8b7f-d7bc42265f65'
export const GROWTH_ACTOR_KNOWLEDGE_AUTHOR = '29379d46-4229-476f-9b9c-1d875e103502'
export const GROWTH_ACTOR_WORKSPACE_COACH = '0e55257c-3396-4c1c-ae68-ea294512a1b5'
export const GROWTH_ACTOR_WORKSPACE_DRIVER = '235188fa-4b58-4f71-ab17-2e5b7cb35402'
export const GROWTH_ACTOR_CHIEF_OF_STAFF = 'a2a57397-8724-4185-a679-ca1acbb9a86c'
export const GROWTH_ACTOR_MEETING_BRIEFER = 'ec42deeb-8f80-4d46-9893-faed8c4dd5c0'
export const GROWTH_ACTOR_MEETING_FOLLOWUP = 'ddde4632-264e-4adf-a3a9-238275f8ea5b'

// ── Use cases ────────────────────────────────────────────────────────────────
// 'Growth' and 'Operations' already exist (see dev-workspace-loops.ts);
// 'Sales' and 'Marketing' are new — the marketplace derives its use-case
// filter chips from whatever distinct values are present in the marketplace, so
// no other registration is required.

export const GROWTH_LOOP_USE_CASE_SALES = 'Sales'
export const GROWTH_LOOP_USE_CASE_MARKETING = 'Marketing'

// ── Lead Gen & Qualification Loop ────────────────────────────────────────────
// Prospector, Qualifier, HubSpot Liaison — sources net-new ICP companies and
// contacts, scores and routes them by fit and persona, keeps the CRM in sync.

export const GROWTH_LOOP_LEAD_GEN_QUALIFICATION_SLUG = 'lead-gen-qualification-loop'
export const GROWTH_LOOP_LEAD_GEN_QUALIFICATION_NAME = 'Lead Gen & Qualification Loop'
export const GROWTH_LOOP_LEAD_GEN_QUALIFICATION_DESCRIPTION =
	'Sources net-new ICP companies and contacts, scores and routes them by fit and persona, and keeps the CRM in sync with the pipeline.'

// ── SDR Outreach Loop ─────────────────────────────────────────────────────────
// Sales Rep, Sales Rep (Magnus), Rune Værk, Sales Coach — runs daily
// territory-based outbound and coaches messaging on what's converting.

export const GROWTH_LOOP_SDR_OUTREACH_SLUG = 'sdr-outreach-loop'
export const GROWTH_LOOP_SDR_OUTREACH_NAME = 'SDR Outreach Loop'
export const GROWTH_LOOP_SDR_OUTREACH_DESCRIPTION =
	"Runs daily territory-based outbound — first touches, personalized follow-ups, and no-reply fallback ladders — and coaches messaging on what's converting."

// ── Deal & Relationship Loop ──────────────────────────────────────────────────
// Deal Closer, Relationship Warmer, SalesOps — advances qualified
// conversations to close, nurtures relationships, keeps CRM hygiene.

export const GROWTH_LOOP_DEAL_RELATIONSHIP_SLUG = 'deal-relationship-loop'
export const GROWTH_LOOP_DEAL_RELATIONSHIP_NAME = 'Deal & Relationship Loop'
export const GROWTH_LOOP_DEAL_RELATIONSHIP_DESCRIPTION =
	'Advances qualified conversations toward close, nurtures existing relationships, and keeps CRM hygiene — dedup and data quality — on a standing cadence.'

// ── Content & Insight Loop ────────────────────────────────────────────────────
// Content Writer, Insight Harvester, Insights Synthesizer — turns inspiration
// and signal into structured insights and grounded content.

export const GROWTH_LOOP_CONTENT_INSIGHT_SLUG = 'content-insight-loop'
export const GROWTH_LOOP_CONTENT_INSIGHT_NAME = 'Content & Insight Loop'
export const GROWTH_LOOP_CONTENT_INSIGHT_DESCRIPTION =
	'Turns inspiration and market signal into structured insights, clusters them into patterns, and drafts customer-facing content grounded in the source.'

// ── Brand & Demand Loop ───────────────────────────────────────────────────────
// Influencer Manager, Demo Video Producer, Visual Designer, Search & AI
// Visibility Analyst, Event Producer — external-facing brand and demand assets.

export const GROWTH_LOOP_BRAND_DEMAND_SLUG = 'brand-demand-loop'
export const GROWTH_LOOP_BRAND_DEMAND_NAME = 'Brand & Demand Loop'
export const GROWTH_LOOP_BRAND_DEMAND_DESCRIPTION =
	'Builds external-facing brand assets — influencer outreach, demo videos, visual design, search/AI visibility, and event presence — to drive inbound demand.'

// ── Growth Bet Loop ───────────────────────────────────────────────────────────
// Growth Strategist, Growth Manager, Growth Ideator — shapes bets from signal
// to hypothesis, opens and adjudicates measurement windows, ideates the next.

export const GROWTH_LOOP_GROWTH_BET_SLUG = 'growth-bet-loop'
export const GROWTH_LOOP_GROWTH_BET_NAME = 'Growth Bet Loop'
export const GROWTH_LOOP_GROWTH_BET_DESCRIPTION =
	'Shapes growth bets from signal to hypothesis, opens and adjudicates their measurement windows, and generates new experiment ideas from what worked.'

// ── Ops & Knowledge Loop ──────────────────────────────────────────────────────
// Knowledge Author, Workspace Coach, Workspace Driver, Chief of Staff — writes
// validated knowledge, observes workspace/agent performance, keeps ops moving.

export const GROWTH_LOOP_OPS_KNOWLEDGE_SLUG = 'ops-knowledge-loop'
export const GROWTH_LOOP_OPS_KNOWLEDGE_NAME = 'Ops & Knowledge Loop'
export const GROWTH_LOOP_OPS_KNOWLEDGE_DESCRIPTION =
	'Writes validated knowledge articles, observes longitudinal workspace and agent performance, and handles day-to-day workspace coordination.'

// ── Meeting Loop ──────────────────────────────────────────────────────────────
// Meeting Briefer, Meeting Follow-up — prepares briefs ahead of meetings and
// turns outcomes into follow-up actions and CRM updates.

export const GROWTH_LOOP_MEETING_SLUG = 'meeting-loop'
export const GROWTH_LOOP_MEETING_NAME = 'Meeting Loop'
export const GROWTH_LOOP_MEETING_DESCRIPTION =
	'Prepares briefs ahead of meetings and turns meeting outcomes into follow-up actions and CRM updates.'
