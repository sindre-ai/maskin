import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createDb } from './connection'
import {
	events,
	actors,
	notifications,
	objects,
	relationships,
	triggers,
	workspaceMembers,
	workspaces,
} from './schema'

// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
const db = createDb(process.env.POSTGRES_URL || process.env.DATABASE_URL!)

function unwrap<T>(value: T | undefined, label: string): T {
	if (!value) throw new Error(`Seed failed: ${label} returned no rows`)
	return value
}

// ── Idempotency: delete existing seed data if present ──────────────────────

const existing = await db
	.select()
	.from(workspaces)
	.where(eq(workspaces.name, 'Product Development'))
if (existing.length > 0) {
	// biome-ignore lint/style/noNonNullAssertion: checked length above
	const wsId = existing[0]!.id
	// Delete in dependency order
	await db.delete(notifications).where(eq(notifications.workspaceId, wsId))
	await db.delete(events).where(eq(events.workspaceId, wsId))
	await db.delete(triggers).where(eq(triggers.workspaceId, wsId))
	// Get all object IDs in this workspace to delete their relationships
	const wsObjects = await db.select().from(objects).where(eq(objects.workspaceId, wsId))
	for (const obj of wsObjects) {
		await db.delete(relationships).where(eq(relationships.sourceId, obj.id))
		await db.delete(relationships).where(eq(relationships.targetId, obj.id))
	}
	await db.delete(objects).where(eq(objects.workspaceId, wsId))
	await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, wsId))
	await db.delete(workspaces).where(eq(workspaces.id, wsId))
	// Delete agent actors created by the demo user, then the demo user
	const [demoActor] = await db.select().from(actors).where(eq(actors.email, 'demo@example.com'))
	if (demoActor) {
		await db.delete(actors).where(eq(actors.createdBy, demoActor.id))
	}
	await db.delete(actors).where(eq(actors.email, 'demo@example.com'))
	console.log('Cleaned up existing seed data')
}

// ── Actor: Demo User ───────────────────────────────────────────────────────

const demoPassword = 'password'
const demoPasswordHash = await bcrypt.hash(demoPassword, 12)
const demoApiKey = `ank_${crypto.randomUUID().replace(/-/g, '')}`

const [rawDemoUser] = await db
	.insert(actors)
	.values({
		type: 'human',
		name: 'Demo User',
		email: 'demo@example.com',
		passwordHash: demoPasswordHash,
		apiKey: demoApiKey,
	})
	.onConflictDoNothing({ target: actors.email })
	.returning()

// If user already existed, fetch them
let demoUser = rawDemoUser
if (!demoUser) {
	const [existing] = await db.select().from(actors).where(eq(actors.email, 'demo@example.com'))
	demoUser = unwrap(existing, 'demoUser')
}
demoUser = unwrap(demoUser, 'demoUser')

// ── Workspace: Product Development ─────────────────────────────────────────

const [rawWorkspace] = await db
	.insert(workspaces)
	.values({
		name: 'Product Development',
		settings: {
			display_names: {
				insight: 'Insight',
				bet: 'Bet',
				task: 'Task',
			},
			statuses: {
				insight: ['new', 'accepted', 'processing', 'clustered', 'discarded'],
				bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
				task: ['todo', 'in_progress', 'in_review', 'done', 'blocked'],
			},
			relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
		},
		createdBy: demoUser.id,
	})
	.returning()

const workspace = unwrap(rawWorkspace, 'workspace')

// ── Membership: Demo User → Workspace ──────────────────────────────────────

await db.insert(workspaceMembers).values({
	workspaceId: workspace.id,
	actorId: demoUser.id,
	role: 'owner',
})

// ── Agent Actors ───────────────────────────────────────────────────────────

const [rawInsightAnalyzer] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Insight Analyzer',
		systemPrompt: `You are the Insight Analyzer agent for the Product Development workspace.

When triggered on an accepted insight, you analyze it for patterns, urgency, and strategic value. You cross-reference with existing insights and bets to find clusters.

Your workflow:
1. Read the newly accepted insight
2. Search for related insights (similar themes, user segments, or product areas)
3. If you find a pattern across 2+ insights, create a new bet at "signal" status with a clear thesis
4. Create "informs" relationships from each contributing insight to the bet
5. Update processed insights to "clustered" status
6. If the insight is standalone, leave it as "accepted" for future clustering

Always explain your reasoning in the bet's content field. Be specific about what signal you're seeing and why it matters.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.3 },
		tools: {
			allowed: [
				'create_objects',
				'update_objects',
				'list_objects',
				'search_objects',
				'create_relationship',
				'update_memory',
				'done',
			],
		},
		createdBy: demoUser.id,
	})
	.returning()

const insightAnalyzer = unwrap(rawInsightAnalyzer, 'insightAnalyzer')

const [rawBetPlanner] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Bet Planner',
		systemPrompt: `You are the Bet Planner agent for the Product Development workspace.

When a bet is promoted to "active" status, you break it down into concrete, actionable tasks. Each task should:
1. Have a clear, specific title (action-oriented: "Build X", "Fix Y", "Design Z")
2. Include a detailed description with acceptance criteria
3. Be small enough to complete in 1-3 days
4. Be set to "todo" status
5. Be connected to the bet via a "breaks_into" relationship
6. Include dependency information if tasks depend on each other (use "blocks" relationships)

Consider the bet's content, any related insights (via "informs" relationships), and what a product team would realistically need to do. Prioritize tasks by impact and order them logically.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.3 },
		tools: {
			allowed: [
				'create_objects',
				'list_objects',
				'get_objects',
				'create_relationship',
				'list_relationships',
				'update_memory',
				'done',
			],
		},
		createdBy: demoUser.id,
	})
	.returning()

const betPlanner = unwrap(rawBetPlanner, 'betPlanner')

const [rawSeniorDev] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Senior Developer',
		systemPrompt: `You are a Senior Developer agent for the Product Development workspace.

When a task moves to "todo" status, you pick it up and implement it. Your workflow:
1. Read the task description and understand the requirements
2. Check the parent bet (via "breaks_into" relationship) for broader context
3. Check if the task has dependencies (via "blocks" relationships) — if blocked, skip it
4. Clone the GitHub repo, create a feature branch, implement the solution
5. Create a PR with a clear description referencing the task and bet
6. Update the task description with the PR link
7. Move the task to "in_review" status

Write production-quality code. Follow existing patterns in the codebase. Keep changes focused.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.2 },
		tools: {
			allowed: [
				'get_objects',
				'update_objects',
				'list_relationships',
				'create_session',
				'update_memory',
				'done',
			],
		},
		createdBy: demoUser.id,
	})
	.returning()

const seniorDev = unwrap(rawSeniorDev, 'seniorDev')

const [rawCodeReviewer] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Code Reviewer',
		systemPrompt: `You are a Code Reviewer agent for the Product Development workspace.

When a task moves to "in_review" status, you review the associated PR. Your workflow:
1. Read the task description to find the PR link
2. Review the PR for code quality, correctness, and alignment with the task requirements
3. Check the parent bet for strategic context
4. If the PR looks good: approve it, merge it, move the task to "done"
5. If changes are needed: leave review comments and keep the task in "in_review"

Focus on: correctness, security, performance, and code clarity. Don't nitpick style — the linter handles that.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.2 },
		tools: {
			allowed: [
				'get_objects',
				'update_objects',
				'list_relationships',
				'create_session',
				'update_memory',
				'done',
			],
		},
		createdBy: demoUser.id,
	})
	.returning()

const codeReviewer = unwrap(rawCodeReviewer, 'codeReviewer')

const [rawObserver] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Workspace Observer',
		systemPrompt: `You are the Workspace Observer agent for the Product Development workspace.

You run daily to analyze workspace activity and surface meta-insights about how the team (humans + agents) is working. Your workflow:
1. Review recent events (last 24 hours)
2. Check the status of all active bets and their tasks
3. Look for patterns: bottlenecks, velocity trends, blocked work, agent performance
4. Create meta-insights (type: "insight") that describe what you observe about the system itself
5. If you spot a systemic issue, recommend a process improvement

Your meta-insights should demonstrate the self-improving loop — you're an AI observing AI-driven product development and suggesting ways to make it better. This is Maskin's core differentiator.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.5 },
		tools: {
			allowed: [
				'create_objects',
				'list_objects',
				'search_objects',
				'get_events',
				'list_relationships',
				'update_memory',
				'done',
			],
		},
		createdBy: demoUser.id,
	})
	.returning()

const observer = unwrap(rawObserver, 'observer')

// Add all agents as workspace members
await db.insert(workspaceMembers).values([
	{ workspaceId: workspace.id, actorId: insightAnalyzer.id, role: 'member' },
	{ workspaceId: workspace.id, actorId: betPlanner.id, role: 'member' },
	{ workspaceId: workspace.id, actorId: seniorDev.id, role: 'member' },
	{ workspaceId: workspace.id, actorId: codeReviewer.id, role: 'member' },
	{ workspaceId: workspace.id, actorId: observer.id, role: 'member' },
])

// ── Insights ───────────────────────────────────────────────────────────────

const [rawInsight1, rawInsight2, rawInsight3, rawInsight4, rawInsight5] = await db
	.insert(objects)
	.values([
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: 'Users abandon onboarding at step 3 (team invite)',
			content:
				'Analytics show a 60% drop-off at the team-invite step during onboarding. Users who skip this step have 40% lower 30-day retention. Support tickets confirm confusion about "why do I need a team to try the product?"',
			status: 'clustered',
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: 'Enterprise customers requesting SAML SSO',
			content:
				"Three enterprise prospects ($50k+ ARR each) have asked about SAML SSO in the last 2 weeks. Two explicitly said it's a blocker for procurement. Current auth is email/password only.",
			status: 'accepted',
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: 'API response times degrade under concurrent agent sessions',
			content:
				'When 5+ agent sessions run concurrently, P99 API latency spikes from 200ms to 3.2s. Root cause appears to be connection pool exhaustion in the database layer. Affects both human users and agent operations.',
			status: 'accepted',
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: 'Power users create custom triggers within first week',
			content:
				'Usage data shows that users who create at least one custom trigger in their first 7 days have 3x higher retention at 90 days. Currently only 12% of users discover the trigger feature.',
			status: 'clustered',
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: 'Competitor launched AI-powered sprint planning',
			content:
				'ProductBoard announced AI sprint planning yesterday. Their approach is rule-based (priority scoring), not agent-based. Key differentiator for us: our agents actually execute tasks, not just plan them. We should highlight this in positioning.',
			status: 'new',
			createdBy: demoUser.id,
		},
	])
	.returning()

const insight1 = unwrap(rawInsight1, 'insight1')
const insight2 = unwrap(rawInsight2, 'insight2')
const insight3 = unwrap(rawInsight3, 'insight3')
const insight4 = unwrap(rawInsight4, 'insight4')
const insight5 = unwrap(rawInsight5, 'insight5')

// ── Bets ───────────────────────────────────────────────────────────────────

const [rawBet1, rawBet2] = await db
	.insert(objects)
	.values([
		{
			workspaceId: workspace.id,
			type: 'bet',
			title: 'Simplify onboarding to reduce drop-off by 50%',
			content:
				'Multiple signals point to onboarding friction as our biggest growth bottleneck. The team-invite step causes a 60% drop-off, and users who struggle through it have poor retention anyway. Bet: if we make onboarding single-player first (defer team invite to post-activation), we can cut drop-off by 50% and improve 30-day retention by 20%.\n\nSuccess criteria:\n- Onboarding completion rate > 80% (currently 40%)\n- 30-day retention for new signups > 60% (currently 45%)\n- Time to first value < 5 minutes',
			status: 'active',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'bet',
			title: 'Make triggers discoverable to boost power-user conversion',
			content:
				'Only 12% of users discover triggers, but those who do have 3x retention. If we surface trigger templates during onboarding and after key moments (first insight created, first bet activated), we can increase trigger adoption to 40% and materially improve retention.\n\nThis is a signal-stage bet — needs validation before committing engineering resources.',
			status: 'proposed',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
	])
	.returning()

const bet1 = unwrap(rawBet1, 'bet1')
const bet2 = unwrap(rawBet2, 'bet2')

// ── Tasks (for active bet1) ────────────────────────────────────────────────

const [rawTask1, rawTask2, rawTask3, rawTask4, rawTask5, rawTask6, rawTask7, rawTask8] = await db
	.insert(objects)
	.values([
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Remove team-invite step from onboarding flow',
			content:
				'Modify the onboarding wizard to skip the team-invite step entirely. Users should go directly from account creation to their first workspace. The team-invite functionality should be accessible from workspace settings instead.\n\nAcceptance criteria:\n- Onboarding flow is 2 steps: create account → enter workspace\n- Team invite is available in workspace settings\n- Existing team invite emails still work',
			status: 'done',
			owner: seniorDev.id,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Add interactive workspace tour for new users',
			content:
				'Build a lightweight product tour that highlights key features (insights, bets, tasks, triggers) when a user enters their workspace for the first time. Use tooltips pointing at real UI elements.\n\nAcceptance criteria:\n- Tour activates on first workspace visit\n- 4-5 steps covering core concepts\n- "Skip tour" option\n- Tour state persisted (don\'t show again)',
			status: 'in_review',
			owner: seniorDev.id,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Create "Getting Started" insight templates',
			content:
				'Pre-populate new workspaces with 3 example insights that demonstrate the insight → bet → task flow. These should be clearly marked as templates and deletable.\n\nAcceptance criteria:\n- 3 template insights created on workspace setup\n- Templates have a "template" tag in metadata\n- Users can dismiss/delete templates',
			status: 'in_progress',
			owner: seniorDev.id,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Add onboarding completion tracking analytics',
			content:
				'Instrument the new onboarding flow with analytics events so we can measure completion rate, time-to-complete, and drop-off points.\n\nAcceptance criteria:\n- Events fired at each onboarding step\n- Dashboard or query to track completion funnel\n- Baseline metrics captured before launch',
			status: 'todo',
			owner: null,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'A/B test: single-player vs team onboarding',
			content:
				'Set up an A/B test to compare the new single-player onboarding against the current team-invite flow. Run for 2 weeks with 50/50 split.\n\nAcceptance criteria:\n- Feature flag controls which flow users see\n- Metrics tracked: completion rate, 7-day retention, time to first insight\n- Statistical significance calculator ready',
			status: 'todo',
			owner: null,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Design empty state for new workspaces',
			content:
				'The workspace feels dead when empty. Design and implement compelling empty states for insights, bets, and tasks views that guide users toward their first action.\n\nAcceptance criteria:\n- Each view (insights, bets, tasks) has a unique empty state\n- Each includes a clear CTA ("Create your first insight")\n- Consistent with design system',
			status: 'in_progress',
			owner: seniorDev.id,
			createdBy: betPlanner.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Investigate database connection pooling for concurrent sessions',
			content:
				'P99 latency spikes to 3.2s when 5+ agent sessions run concurrently due to connection pool exhaustion. Research and implement PgBouncer or application-level pooling.\n\nAcceptance criteria:\n- P99 latency < 500ms with 10 concurrent sessions\n- Connection pool size is configurable\n- Load test results documented',
			status: 'todo',
			owner: null,
			createdBy: demoUser.id,
		},
		{
			workspaceId: workspace.id,
			type: 'task',
			title: 'Write migration guide for team-invite removal',
			content:
				'Document the change for existing users who relied on the onboarding team-invite step. Include where to find team management now and any API changes.\n\nAcceptance criteria:\n- Migration guide in docs\n- In-app notification for existing users about the change\n- Support team briefed',
			status: 'done',
			owner: seniorDev.id,
			createdBy: betPlanner.id,
		},
	])
	.returning()

const task1 = unwrap(rawTask1, 'task1')
const task2 = unwrap(rawTask2, 'task2')
const task3 = unwrap(rawTask3, 'task3')
const task4 = unwrap(rawTask4, 'task4')
const task5 = unwrap(rawTask5, 'task5')
const task6 = unwrap(rawTask6, 'task6')
const task7 = unwrap(rawTask7, 'task7')
const task8 = unwrap(rawTask8, 'task8')

// ── Meta-insights (from Workspace Observer) ────────────────────────────────

const [rawMetaInsight1, rawMetaInsight2] = await db
	.insert(objects)
	.values([
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: '[Meta] Agent velocity: 3 tasks completed in 48 hours with zero human intervention',
			content:
				'Observing the "Simplify onboarding" bet: the Senior Developer agent completed task 1 (remove team-invite step) and task 8 (migration guide), and the Code Reviewer agent approved both PRs — all within 48 hours of the bet going active. No human input was needed beyond the initial bet activation.\n\nThis is the self-improving loop in action: insights informed a bet, the Bet Planner broke it into tasks, and agents executed autonomously. The remaining tasks need human decisions (A/B test parameters, design review), which is the right division of labor.\n\n**Recommendation:** Consider adding an "auto-assign" trigger that routes tasks to agents based on task type (code tasks → Senior Developer, design tasks → human, testing tasks → QA agent).',
			status: 'new',
			createdBy: observer.id,
		},
		{
			workspaceId: workspace.id,
			type: 'insight',
			title: '[Meta] Bottleneck detected: "in_review" tasks aging > 24 hours',
			content:
				'Task "Add interactive workspace tour" has been in review for 26 hours. The Code Reviewer agent flagged 2 minor issues but the Senior Developer hasn\'t addressed them yet. This creates a cascade delay for task 3 which has an implicit dependency.\n\n**Pattern:** Review cycles are becoming the bottleneck, not implementation. The agents implement faster than reviews clear.\n\n**Recommendation:** Consider auto-merging PRs when the Code Reviewer approves with no blocking issues, and only escalate to human review for high-risk changes (security, data model, infrastructure).',
			status: 'new',
			createdBy: observer.id,
		},
	])
	.returning()

const metaInsight1 = unwrap(rawMetaInsight1, 'metaInsight1')
const metaInsight2 = unwrap(rawMetaInsight2, 'metaInsight2')

// ── Relationships ──────────────────────────────────────────────────────────

await db.insert(relationships).values([
	// Insights → Bets (informs)
	{
		sourceType: 'insight',
		sourceId: insight1.id,
		targetType: 'bet',
		targetId: bet1.id,
		type: 'informs',
		createdBy: insightAnalyzer.id,
	},
	{
		sourceType: 'insight',
		sourceId: insight4.id,
		targetType: 'bet',
		targetId: bet2.id,
		type: 'informs',
		createdBy: insightAnalyzer.id,
	},
	// Bet → Tasks (breaks_into)
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task1.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task2.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task3.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task4.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task5.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task6.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task8.id,
		type: 'breaks_into',
		createdBy: betPlanner.id,
	},
	// Insight → standalone task (informs)
	{
		sourceType: 'insight',
		sourceId: insight3.id,
		targetType: 'task',
		targetId: task7.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
	// Task dependencies (blocks)
	{
		sourceType: 'task',
		sourceId: task4.id,
		targetType: 'task',
		targetId: task5.id,
		type: 'blocks',
		createdBy: betPlanner.id,
	},
	// Meta-insight relates to bet
	{
		sourceType: 'insight',
		sourceId: metaInsight1.id,
		targetType: 'bet',
		targetId: bet1.id,
		type: 'relates_to',
		createdBy: observer.id,
	},
	{
		sourceType: 'insight',
		sourceId: metaInsight2.id,
		targetType: 'task',
		targetId: task2.id,
		type: 'relates_to',
		createdBy: observer.id,
	},
])

// ── Triggers ───────────────────────────────────────────────────────────────

await db.insert(triggers).values([
	{
		workspaceId: workspace.id,
		name: 'Analyze accepted insights',
		type: 'event',
		config: { entity_type: 'insight', action: 'status_changed', filter: { status: 'accepted' } },
		actionPrompt:
			'An insight has been accepted. Analyze it for patterns with other insights and determine if it should be clustered into a new or existing bet.',
		targetActorId: insightAnalyzer.id,
		enabled: true,
		createdBy: demoUser.id,
	},
	{
		workspaceId: workspace.id,
		name: 'Plan active bets',
		type: 'event',
		config: { entity_type: 'bet', action: 'status_changed', filter: { status: 'active' } },
		actionPrompt:
			'A bet has been promoted to active. Break it down into concrete, actionable tasks with clear acceptance criteria and dependencies.',
		targetActorId: betPlanner.id,
		enabled: true,
		createdBy: demoUser.id,
	},
	{
		workspaceId: workspace.id,
		name: 'Implement todo tasks',
		type: 'event',
		config: { entity_type: 'task', action: 'status_changed', filter: { status: 'todo' } },
		actionPrompt:
			'A task has moved to todo. Pick it up, understand the context from the parent bet, implement the solution, create a PR, and move the task to in_review.',
		targetActorId: seniorDev.id,
		enabled: true,
		createdBy: demoUser.id,
	},
	{
		workspaceId: workspace.id,
		name: 'Review tasks in review',
		type: 'event',
		config: {
			entity_type: 'task',
			action: 'status_changed',
			filter: { status: 'in_review' },
		},
		actionPrompt:
			'A task has moved to in_review. Find the PR link in the task description, review the code for quality and correctness, and either approve+merge (move to done) or request changes.',
		targetActorId: codeReviewer.id,
		enabled: true,
		createdBy: demoUser.id,
	},
	{
		workspaceId: workspace.id,
		name: 'Daily workspace health check',
		type: 'cron',
		config: { schedule: '0 9 * * *' },
		actionPrompt:
			'Run your daily workspace analysis. Review activity from the last 24 hours, check for bottlenecks, blocked work, and velocity trends. Create meta-insights about how the team is performing and suggest improvements.',
		targetActorId: observer.id,
		enabled: true,
		createdBy: demoUser.id,
	},
])

// ── Events (pre-populated activity feed) ───────────────────────────────────

const now = new Date()
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000)

await db.insert(events).values([
	// Day 1: Insights arrive
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'insight',
		entityId: insight1.id,
		data: { title: insight1.title },
		createdAt: hoursAgo(72),
	},
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'insight',
		entityId: insight2.id,
		data: { title: insight2.title },
		createdAt: hoursAgo(70),
	},
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'insight',
		entityId: insight3.id,
		data: { title: insight3.title },
		createdAt: hoursAgo(68),
	},
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'insight',
		entityId: insight4.id,
		data: { title: insight4.title },
		createdAt: hoursAgo(66),
	},
	// Insight Analyzer clusters insights into bet
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'status_changed',
		entityType: 'insight',
		entityId: insight1.id,
		data: { title: insight1.title, from: 'new', to: 'accepted' },
		createdAt: hoursAgo(64),
	},
	{
		workspaceId: workspace.id,
		actorId: insightAnalyzer.id,
		action: 'status_changed',
		entityType: 'insight',
		entityId: insight1.id,
		data: { title: insight1.title, from: 'accepted', to: 'clustered' },
		createdAt: hoursAgo(63),
	},
	{
		workspaceId: workspace.id,
		actorId: insightAnalyzer.id,
		action: 'created',
		entityType: 'bet',
		entityId: bet1.id,
		data: { title: bet1.title },
		createdAt: hoursAgo(63),
	},
	// Bet promoted to active
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'status_changed',
		entityType: 'bet',
		entityId: bet1.id,
		data: { title: bet1.title, from: 'signal', to: 'active' },
		createdAt: hoursAgo(60),
	},
	// Bet Planner creates tasks
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task1.id,
		data: { title: task1.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task2.id,
		data: { title: task2.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task3.id,
		data: { title: task3.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task4.id,
		data: { title: task4.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task5.id,
		data: { title: task5.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task6.id,
		data: { title: task6.title },
		createdAt: hoursAgo(59),
	},
	{
		workspaceId: workspace.id,
		actorId: betPlanner.id,
		action: 'created',
		entityType: 'task',
		entityId: task8.id,
		data: { title: task8.title },
		createdAt: hoursAgo(59),
	},
	// Senior Dev picks up tasks
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task1.id,
		data: { title: task1.title, from: 'todo', to: 'in_progress' },
		createdAt: hoursAgo(55),
	},
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task1.id,
		data: { title: task1.title, from: 'in_progress', to: 'in_review' },
		createdAt: hoursAgo(50),
	},
	// Code Reviewer approves and merges
	{
		workspaceId: workspace.id,
		actorId: codeReviewer.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task1.id,
		data: { title: task1.title, from: 'in_review', to: 'done' },
		createdAt: hoursAgo(48),
	},
	// More tasks flow through the pipeline
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task8.id,
		data: { title: task8.title, from: 'todo', to: 'in_progress' },
		createdAt: hoursAgo(47),
	},
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task8.id,
		data: { title: task8.title, from: 'in_progress', to: 'in_review' },
		createdAt: hoursAgo(44),
	},
	{
		workspaceId: workspace.id,
		actorId: codeReviewer.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task8.id,
		data: { title: task8.title, from: 'in_review', to: 'done' },
		createdAt: hoursAgo(42),
	},
	// Task 2: tour feature (currently in review)
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task2.id,
		data: { title: task2.title, from: 'todo', to: 'in_progress' },
		createdAt: hoursAgo(40),
	},
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task2.id,
		data: { title: task2.title, from: 'in_progress', to: 'in_review' },
		createdAt: hoursAgo(26),
	},
	// Tasks 3 and 6 picked up (in progress)
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task3.id,
		data: { title: task3.title, from: 'todo', to: 'in_progress' },
		createdAt: hoursAgo(20),
	},
	{
		workspaceId: workspace.id,
		actorId: seniorDev.id,
		action: 'status_changed',
		entityType: 'task',
		entityId: task6.id,
		data: { title: task6.title, from: 'todo', to: 'in_progress' },
		createdAt: hoursAgo(18),
	},
	// New insight arrives
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'insight',
		entityId: insight5.id,
		data: { title: insight5.title },
		createdAt: hoursAgo(8),
	},
	// Workspace Observer creates meta-insights
	{
		workspaceId: workspace.id,
		actorId: observer.id,
		action: 'created',
		entityType: 'insight',
		entityId: metaInsight1.id,
		data: { title: metaInsight1.title },
		createdAt: hoursAgo(6),
	},
	{
		workspaceId: workspace.id,
		actorId: observer.id,
		action: 'created',
		entityType: 'insight',
		entityId: metaInsight2.id,
		data: { title: metaInsight2.title },
		createdAt: hoursAgo(6),
	},
	// Standalone task created from insight
	{
		workspaceId: workspace.id,
		actorId: demoUser.id,
		action: 'created',
		entityType: 'task',
		entityId: task7.id,
		data: { title: task7.title },
		createdAt: hoursAgo(4),
	},
])

// ── Notifications ──────────────────────────────────────────────────────────

await db.insert(notifications).values([
	{
		workspaceId: workspace.id,
		type: 'recommendation',
		title: 'Pattern detected: onboarding friction is your #1 growth bottleneck',
		content:
			'I analyzed 3 recent insights and found a strong signal around onboarding friction. The 60% drop-off at team-invite, combined with the retention data, suggests this is the highest-leverage area to invest in. I created a bet with a clear thesis and success criteria.',
		metadata: {
			urgency_label: 'High confidence signal',
			meta_text: '3 supporting insights · 60% drop-off rate',
			tags: ['Onboarding drop-off', 'Retention correlation', 'Team-invite friction'],
			suggestion:
				'I created the bet "Simplify onboarding to reduce drop-off by 50%". Want to activate it?',
		},
		sourceActorId: insightAnalyzer.id,
		targetActorId: demoUser.id,
		objectId: bet1.id,
		status: 'seen',
	},
	{
		workspaceId: workspace.id,
		type: 'good_news',
		title: '2 tasks completed autonomously in 48 hours',
		content:
			'The "Simplify onboarding" bet is making great progress. Senior Developer completed "Remove team-invite step" and "Write migration guide", both reviewed and merged by Code Reviewer — all without human intervention.',
		metadata: {
			tags: ['2/8 tasks done', '48h autonomous cycle', 'Zero human input needed'],
		},
		sourceActorId: observer.id,
		targetActorId: demoUser.id,
		objectId: bet1.id,
		status: 'pending',
	},
	{
		workspaceId: workspace.id,
		type: 'alert',
		title: 'Review bottleneck: "Add interactive workspace tour" in review for 26 hours',
		content:
			"The Code Reviewer flagged 2 minor issues on the workspace tour PR, but the Senior Developer hasn't addressed them yet. This is blocking downstream progress.",
		metadata: {
			urgency_label: 'Action needed',
			meta_text: 'In review for 26 hours · 2 comments unresolved',
			tags: ['Workspace tour PR', 'Review cycle bottleneck'],
		},
		sourceActorId: observer.id,
		targetActorId: demoUser.id,
		objectId: task2.id,
		status: 'pending',
	},
	{
		workspaceId: workspace.id,
		type: 'needs_input',
		title: 'A/B test parameters needed for onboarding experiment',
		content:
			'Task "A/B test: single-player vs team onboarding" is ready to implement, but I need your input on the test parameters before proceeding.',
		metadata: {
			urgency_label: 'Needs you now',
			meta_text: 'Blocking task 5 · Analytics task 4 also waiting',
			question: 'What traffic split and duration should we use for the A/B test?',
			options: [
				{
					label: '50/50 for 2 weeks',
					value: '50_50_2w',
					description: 'Standard split, fastest to significance',
				},
				{
					label: '80/20 favoring new flow',
					value: '80_20_2w',
					description: 'Less risk, slower to significance',
				},
				{
					label: 'Skip A/B, ship new flow',
					value: 'skip',
					description: 'Data from completed tasks already shows improvement',
				},
			],
			tags: ['A/B test parameters', 'Onboarding experiment'],
		},
		sourceActorId: seniorDev.id,
		targetActorId: demoUser.id,
		objectId: task5.id,
		status: 'pending',
	},
])

console.log('Seed complete — Product Development workspace created')
console.log(`  Workspace: ${workspace.id}`)
console.log(`  Demo user: ${demoUser.id} (demo@example.com / ${demoPassword})`)
console.log(
	`  Agents: ${[insightAnalyzer, betPlanner, seniorDev, codeReviewer, observer].map((a) => a.name).join(', ')}`,
)
console.log('  Objects: 5 insights + 2 meta-insights, 2 bets, 8 tasks')
console.log('  Triggers: 5 (4 event-based, 1 cron)')
console.log('  Events: 30 activity feed entries')
console.log('  Notifications: 4')
process.exit(0)
