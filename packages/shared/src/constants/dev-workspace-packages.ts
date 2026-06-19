// Canonical source-item IDs for the Development Workspace catalog packages.
// These are the IDs of the actors and triggers in the Maskin development workspace
// (fe944fe6-7b45-478c-afc7-b889cea63c08). All seeding paths import from here so
// each actor/trigger ID is only written in one place.

// ── Actor IDs ────────────────────────────────────────────────────────────────

export const DEV_ACTOR_PLANNER = 'aebcb7eb-6403-4df8-8275-a229fd7fc94d'
export const DEV_ACTOR_DEVELOPER = '212d2818-09df-4751-b8df-d0f1108ec0c1'
export const DEV_ACTOR_ARCHITECT = '3008a649-df16-41f1-a187-5d4613d3767a'
export const DEV_ACTOR_DESIGNER = '222901a5-8bac-43c9-9291-94c09c820829'
export const DEV_ACTOR_PRODUCT_MARKETER = 'e8ff87f1-f5ac-44cd-a35a-60d01dd12470'
export const DEV_ACTOR_CODE_REVIEWER = '01936a6b-258e-4daa-8637-a926f16040ce'
export const DEV_ACTOR_ACCEPTANCE_VALIDATOR = '4c1a09da-dca8-4972-8a6f-68717197ffe3'
export const DEV_ACTOR_AUTO_MERGE_BOT = '2b4d2261-b361-4f01-a711-c68e62af3217'
export const DEV_ACTOR_STRATEGIST = 'c524aac2-4373-485b-b709-bbb4eb2d021e'
export const DEV_ACTOR_WORKSPACE_DRIVER = 'd625cf31-fb6c-45df-a8c2-e2823d6053ae'
export const DEV_ACTOR_RESEARCH_AGENT = '3b0337d0-7bed-467d-8239-544e7611a587'
export const DEV_ACTOR_WORKSPACE_COACH = '9b4820ab-3d00-4e15-b737-8adf7f94d15c'
export const DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR = '3322def3-7d6b-4615-beaf-b43b291f95a8'
export const DEV_ACTOR_PRODUCT_ANALYST = '21cce128-9c80-4ebe-982f-41c82820c6aa'
export const DEV_ACTOR_SUMMARIZATION_AGENT = '29a22f4b-3d56-4377-a226-968b0192c39e'

// ── Package slugs ────────────────────────────────────────────────────────────

export const DEV_PACKAGE_PLANNER_SLUG = 'planner'
export const DEV_PACKAGE_DEVELOPER_SLUG = 'developer'
export const DEV_PACKAGE_ARCHITECT_SLUG = 'architect'
export const DEV_PACKAGE_DESIGNER_SLUG = 'designer'
export const DEV_PACKAGE_PRODUCT_MARKETER_SLUG = 'product-marketer'
export const DEV_PACKAGE_CODE_REVIEWER_SLUG = 'code-reviewer'
export const DEV_PACKAGE_ACCEPTANCE_VALIDATOR_SLUG = 'acceptance-validator'
export const DEV_PACKAGE_AUTO_MERGE_BOT_SLUG = 'auto-merge-bot'
export const DEV_PACKAGE_STRATEGIST_SLUG = 'strategist'
export const DEV_PACKAGE_WORKSPACE_DRIVER_SLUG = 'workspace-driver'
export const DEV_PACKAGE_RESEARCH_AGENT_SLUG = 'research-agent'
export const DEV_PACKAGE_WORKSPACE_COACH_SLUG = 'workspace-coach'
export const DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_SLUG = 'retro-knowledge-author'
export const DEV_PACKAGE_PRODUCT_ANALYST_SLUG = 'product-analyst'
export const DEV_PACKAGE_SUMMARIZATION_AGENT_SLUG = 'summarization-agent'

// ── Package names ────────────────────────────────────────────────────────────

export const DEV_PACKAGE_PLANNER_NAME = 'Planner'
export const DEV_PACKAGE_DEVELOPER_NAME = 'Developer'
export const DEV_PACKAGE_ARCHITECT_NAME = 'Architect'
export const DEV_PACKAGE_DESIGNER_NAME = 'Designer'
export const DEV_PACKAGE_PRODUCT_MARKETER_NAME = 'Product Marketer'
export const DEV_PACKAGE_CODE_REVIEWER_NAME = 'Code Reviewer'
export const DEV_PACKAGE_ACCEPTANCE_VALIDATOR_NAME = 'Acceptance Validator'
export const DEV_PACKAGE_AUTO_MERGE_BOT_NAME = 'Auto-Merge Bot'
export const DEV_PACKAGE_STRATEGIST_NAME = 'Strategist'
export const DEV_PACKAGE_WORKSPACE_DRIVER_NAME = 'Workspace Driver'
export const DEV_PACKAGE_RESEARCH_AGENT_NAME = 'Research Agent'
export const DEV_PACKAGE_WORKSPACE_COACH_NAME = 'Workspace Coach'
export const DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_NAME = 'Retro & Knowledge Author'
export const DEV_PACKAGE_PRODUCT_ANALYST_NAME = 'Product Analyst'
export const DEV_PACKAGE_SUMMARIZATION_AGENT_NAME = 'Summarization Agent'

// ── Shared version ────────────────────────────────────────────────────────────

export const DEV_PACKAGE_VERSION = '1.0.0'

// ── Use cases ────────────────────────────────────────────────────────────────

export const DEV_PACKAGE_USE_CASE_DEVELOPMENT = 'Development'

// ── Descriptions ────────────────────────────────────────────────────────────

export const DEV_PACKAGE_PLANNER_DESCRIPTION =
	'Decomposes bets into ordered tasks and advances the bet to active, kicking off agent implementation.'

export const DEV_PACKAGE_DEVELOPER_DESCRIPTION =
	'Implements coding tasks, opens PRs on the bet branch, and self-reviews before handing off to the Code Reviewer.'

export const DEV_PACKAGE_ARCHITECT_DESCRIPTION =
	'Researches the codebase, evaluates technical options, and posts a concrete ADR-style proposal for human approval before development begins.'

export const DEV_PACKAGE_DESIGNER_DESCRIPTION =
	'Produces interactive HTML prototypes grounded in the live design system and verified in-browser before posting for approval.'

export const DEV_PACKAGE_PRODUCT_MARKETER_DESCRIPTION =
	'Writes customer-facing copy (release log entries, landing pages, in-app announcements) grounded in what actually shipped.'

export const DEV_PACKAGE_CODE_REVIEWER_DESCRIPTION =
	'Reviews PRs for quality and correctness, fixes critical issues, computes a deterministic risk score, and hands off to the Acceptance Validator.'

export const DEV_PACKAGE_ACCEPTANCE_VALIDATOR_DESCRIPTION =
	'Validates that implementations actually deliver their stated goals and match approved design and architecture specs before marking tasks done.'

export const DEV_PACKAGE_AUTO_MERGE_BOT_DESCRIPTION =
	'Automatically merges low-risk PRs into the bet branch and, on qualifying bets, squash-merges to main and advances the bet to live.'

export const DEV_PACKAGE_STRATEGIST_DESCRIPTION =
	'Shapes bets, enforces quality gates at every lifecycle transition, runs bi-weekly Bet Council scoring, and drives acceptance review after PRs merge.'

export const DEV_PACKAGE_WORKSPACE_DRIVER_DESCRIPTION =
	'Keeps the pipeline moving: advances stalled tasks, triages GitHub PRs, runs liveness watchdogs, and handles bet-lifecycle plumbing in real time.'

export const DEV_PACKAGE_RESEARCH_AGENT_DESCRIPTION =
	'Pulls external intelligence: daily meeting insights, live-bet evidence, influencer content, market research, and on-demand social URL extraction.'

export const DEV_PACKAGE_WORKSPACE_COACH_DESCRIPTION =
	'Observes longitudinal patterns in how the team and agents perform, surfaces rework signals and bottlenecks, and digests daily actions for human review.'

export const DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_DESCRIPTION =
	'Writes retros at bet terminal events, converts clustered insights into validated Knowledge articles, and runs weekly knowledge revision sweeps.'

export const DEV_PACKAGE_PRODUCT_ANALYST_DESCRIPTION =
	'Measures live bets against PostHog metrics daily and runs weekly discovery sweeps to surface adoption and friction signals from analytics data.'

export const DEV_PACKAGE_SUMMARIZATION_AGENT_DESCRIPTION =
	'Turns finished meetings into insights, tasks, and contact objects, wiring relationships so context flows into active bets automatically.'
