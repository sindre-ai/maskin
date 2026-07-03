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

// ── Trigger IDs ───────────────────────────────────────────────────────────────

// Planner
export const DEV_TRIGGER_PLANNER_BET_DEFINE = '5d6db16c-278a-4831-a5ff-12be6d200726'
export const DEV_TRIGGER_PLANNER_BET_ACTIVE = '2dc018de-574f-4510-b846-d4f4f306d40b'

// Developer
export const DEV_TRIGGER_DEVELOPER_TASK_IN_PROGRESS = '13a76463-7d57-4332-b37d-a5a8174ccad7'

// Architect
export const DEV_TRIGGER_ARCHITECT_TASK_IN_PROGRESS = '6b84d265-8684-4078-b90b-e5b4e3c6700c'

// Designer
export const DEV_TRIGGER_DESIGNER_TASK_IN_PROGRESS = '5395a818-2ff8-4db1-95fe-37cc48a06b18'

// Product Marketer
export const DEV_TRIGGER_PRODUCT_MARKETER_TASK_IN_PROGRESS = '7110b6ae-095a-4aef-9cdc-ad8a1191fb17'

// Code Reviewer
export const DEV_TRIGGER_CODE_REVIEWER_TASK_IN_REVIEW = '2a8f9709-c239-4f92-9ebf-6e21022d4b80'
export const DEV_TRIGGER_CODE_REVIEWER_PR_SYNCHRONIZE = 'a7dead80-190e-4da0-86bf-e5500994716b'

// Acceptance Validator
export const DEV_TRIGGER_ACCEPTANCE_VALIDATOR_TASK_VALIDATED =
	'89bd7d2a-2256-4aef-8960-4c5669307e9c'

// Auto-Merge Bot
export const DEV_TRIGGER_AUTO_MERGE_BOT_TASK_DONE = 'a941beb1-78af-4ac9-b079-b198f8e9c92a'

// Strategist
export const DEV_TRIGGER_STRATEGIST_BET_CREATED = '34b43df6-a012-49f3-bdf3-de1b5017612b'
export const DEV_TRIGGER_STRATEGIST_BET_DEFINE = 'd02d5e55-c1c3-4091-b344-fea157579095'
export const DEV_TRIGGER_STRATEGIST_BET_ACTIVE = 'af9b6afc-67d2-481b-8b28-0df09a6e7c76'
export const DEV_TRIGGER_STRATEGIST_BET_LIVE = '11ee9406-254b-4621-be03-487565f250a0'
export const DEV_TRIGGER_STRATEGIST_INSIGHT_STATUS_CHANGED = 'f5ab2e5b-cd2c-4ff2-85fb-5d5f8470b6f0'
export const DEV_TRIGGER_STRATEGIST_INFORMS_EDGE = '6310ae18-d8ff-435a-93ce-13a92bd71b7a'
export const DEV_TRIGGER_STRATEGIST_DESIGN_ARCH_IN_REVIEW = '731af1d4-4eb3-4a74-98c3-8a59b671183e'
export const DEV_TRIGGER_STRATEGIST_BIWEEKLY_BET_COUNCIL = '2cfdf16d-87ee-4bae-b909-574ddc42add3'
export const DEV_TRIGGER_STRATEGIST_BIWEEKLY_SCORING_PASS = '0d4fd8a7-9c93-4f3b-981a-dfd285804d6b'

// Workspace Driver
export const DEV_TRIGGER_WORKSPACE_DRIVER_TASK_DONE = '66fddb79-f49f-4f77-b4f2-28da1e022765'
export const DEV_TRIGGER_WORKSPACE_DRIVER_BET_ACTIVATED = '243d019f-f012-419e-9128-7fa20406b6e8'
export const DEV_TRIGGER_WORKSPACE_DRIVER_PR_OPENED = '88b1e6bc-cb4f-4963-896a-4ea1d5fc2f9f'
export const DEV_TRIGGER_WORKSPACE_DRIVER_PR_MERGED = '530dceac-4e83-4b98-a3da-f0af9138a222'
export const DEV_TRIGGER_WORKSPACE_DRIVER_TASK_CREATED = '506dc2c1-8567-4d1a-9ebd-992b7e1620a3'
export const DEV_TRIGGER_WORKSPACE_DRIVER_LIVENESS_WATCHDOG = 'f3442d78-b02b-4f42-b12b-3a8467a71d92'
export const DEV_TRIGGER_WORKSPACE_DRIVER_PIPELINE_WATCHDOG = '7fc5b39f-d27d-4786-b194-d2105fc32dbf'
export const DEV_TRIGGER_WORKSPACE_DRIVER_DAILY_BET_SWEEP = 'd8a7671e-c68b-4a8f-b933-6d4a98756b74'
export const DEV_TRIGGER_WORKSPACE_DRIVER_DAILY_MENTION_AUDIT =
	'35b21a0e-2b16-4b5d-9e31-74156d13e4f3'

// Research Agent
export const DEV_TRIGGER_RESEARCH_AGENT_SLACK_DM = '79fecd6f-e8fa-4ac8-b0b0-5e238a534786'
export const DEV_TRIGGER_RESEARCH_AGENT_INSPIRATION_RESOURCES =
	'df3dbfb9-0aa7-4b89-ad99-10d606ae4068'
export const DEV_TRIGGER_RESEARCH_AGENT_DAILY_MEETING_INSIGHTS =
	'ecc87493-64f9-4bb6-8aa3-639b10b2821a'
export const DEV_TRIGGER_RESEARCH_AGENT_DAILY_LIVE_BET_EVIDENCE =
	'b1f9a467-9fc7-4377-a50a-95735fed1e92'
export const DEV_TRIGGER_RESEARCH_AGENT_DAILY_INFLUENCER_CONTENT =
	'a6c1ec67-23f5-4fbb-aff6-78c8c883995f'
export const DEV_TRIGGER_RESEARCH_AGENT_WEEKLY_MARKET_RESEARCH =
	'9e0a4be4-cfa9-40e3-a187-8241648827b9'
export const DEV_TRIGGER_RESEARCH_AGENT_WEEKLY_COMPETITOR = 'd95ef32a-0371-40b2-8fd3-4e7a60db9de5'

// Workspace Coach
export const DEV_TRIGGER_WORKSPACE_COACH_DAILY_OBSERVATION = '2e39b3b0-f923-4b46-99d8-168e495fc834'
export const DEV_TRIGGER_WORKSPACE_COACH_DAILY_CODE_REVIEW_ANALYSIS =
	'9bd7d1be-4f83-4143-8f97-9a5f3f21cf0f'
export const DEV_TRIGGER_WORKSPACE_COACH_DAILY_ACCEPTANCE_ANALYSIS =
	'9123be90-f1b0-46c0-823a-3885bbe94a73'
export const DEV_TRIGGER_WORKSPACE_COACH_DAILY_HANDBOOK_DRIFT =
	'9309764c-d5fa-4558-b1cc-a273ca4ad64c'
export const DEV_TRIGGER_WORKSPACE_COACH_WEEKLY_INSIGHT_PATTERN =
	'17b7f5b9-2b56-4c82-a6ef-1378e1c5b9f3'
export const DEV_TRIGGER_WORKSPACE_COACH_DAILY_HUMAN_ACTIONS_DIGEST =
	'dc380444-ac71-4b89-8634-ce73c664fa0b'

// Retro & Knowledge Author
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_INSIGHT_CLUSTERED =
	'e54bb3bf-818e-423a-8c49-d1009528a006'
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_BET_SUCCEEDED =
	'8e9deb8f-1941-4271-9da7-f696c2fb1490'
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_BET_FAILED = '4b30f54f-ff12-4208-9cd6-147e603aa2d2'
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_BET_PAUSED = '9e93df5a-63d9-49ee-bead-d7b25de45cfb'
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_DAILY_FEEDBACK =
	'3578d807-78cc-48dc-a12b-5028eb973103'
export const DEV_TRIGGER_RETRO_KNOWLEDGE_AUTHOR_WEEKLY_REVISION =
	'ae20bd9c-c039-4786-b6eb-e8e70ef7926e'

// Product Analyst
export const DEV_TRIGGER_PRODUCT_ANALYST_DAILY_MEASUREMENT = 'fe28005d-f465-49b9-a73d-2dc599036345'
export const DEV_TRIGGER_PRODUCT_ANALYST_WEEKLY_DISCOVERY = '665c1b46-23bf-4666-98a2-a6902a0d1dc5'

// Summarization Agent
export const DEV_TRIGGER_SUMMARIZATION_AGENT_MEETING_DONE = '5eefd3e7-396b-4de1-9fdf-a22ccfc0d120'

// ── Development Pipeline bundle ───────────────────────────────────────────────

export const DEV_PACKAGE_DEVELOPMENT_PIPELINE_SLUG = 'development-pipeline'
export const DEV_PACKAGE_DEVELOPMENT_PIPELINE_NAME = 'Development Pipeline'
export const DEV_PACKAGE_DEVELOPMENT_PIPELINE_DESCRIPTION =
	'Implements tasks, reviews PRs for quality and risk, and validates that implementations deliver their stated goals before marking work done.'
