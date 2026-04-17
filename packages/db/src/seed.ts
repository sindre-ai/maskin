import { createDb } from './connection'
import {
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

// ── Actor ───────────────────────────────────────────────────────────────────

const [rawDemoUser] = await db
	.insert(actors)
	.values({
		type: 'human',
		name: 'Demo User',
		email: 'demo@example.com',
	})
	.returning()

const demoUser = unwrap(rawDemoUser, 'demoUser')

// ── Workspace ───────────────────────────────────────────────────────────────

const [rawDemoWorkspace] = await db
	.insert(workspaces)
	.values({
		name: 'Demo Workspace',
		createdBy: demoUser.id,
	})
	.returning()

const demoWorkspace = unwrap(rawDemoWorkspace, 'demoWorkspace')

// ── Membership ──────────────────────────────────────────────────────────────

await db.insert(workspaceMembers).values({
	workspaceId: demoWorkspace.id,
	actorId: demoUser.id,
	role: 'owner',
})

// ── Agent Actors ────────────────────────────────────────────────────────────

// Create Insight Clusterer agent
const [rawClusterer] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Insight Clusterer',
		systemPrompt: `You are an AI agent that analyzes insights and clusters them into bets.

When triggered, review all new/unprocessed insights in the workspace. Look for patterns, themes, and recurring signals. Group related insights together and create "bet" objects that represent strategic opportunities or problems worth addressing.

For each bet you create:
1. Give it a clear, actionable title
2. Write a summary in the content field explaining the pattern you identified
3. Set status to "signal"
4. Create "informs" relationships from each source insight to the bet
5. Update processed insights to status "clustered"

Use the update_memory tool to track which insights you've already processed.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.3 },
		tools: {
			allowed: [
				'create_object',
				'update_object',
				'list_objects',
				'create_relationship',
				'update_memory',
				'done',
			],
		},
	})
	.returning()

const clusterer = unwrap(rawClusterer, 'clusterer')

// Create Bet Decomposer agent
const [rawDecomposer] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Bet Decomposer',
		systemPrompt: `You are an AI agent that breaks down active bets into actionable tasks.

When a bet is promoted to "active" status, analyze it and create a set of concrete, actionable tasks that would move the bet forward. Each task should be:
1. Specific and actionable (not vague)
2. Small enough to complete in 1-3 days
3. Clearly titled
4. Set to status "todo"
5. Connected to the bet via a "breaks_into" relationship

Consider the bet's content, any related insights, and what a product team would need to do to act on this opportunity.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-sonnet-4-20250514', temperature: 0.3 },
		tools: {
			allowed: ['create_object', 'list_objects', 'create_relationship', 'update_memory', 'done'],
		},
	})
	.returning()

const decomposer = unwrap(rawDecomposer, 'decomposer')

// Add agents as workspace members
await db.insert(workspaceMembers).values([
	{ workspaceId: demoWorkspace.id, actorId: clusterer.id, role: 'member' },
	{ workspaceId: demoWorkspace.id, actorId: decomposer.id, role: 'member' },
])

// ── Insights ────────────────────────────────────────────────────────────────

const [rawInsight1, rawInsight2, rawInsight3] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'Users abandon onboarding at step 3',
			content: 'Analytics show a 60% drop-off at the team-invite step.',
			status: 'open',
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'Most active users rely on keyboard shortcuts',
			content: 'Power users complete tasks 3x faster with shortcuts.',
			status: 'open',
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'insight',
			title: 'API latency spikes during peak hours',
			content: 'P99 latency exceeds 2s between 9-11 AM UTC.',
			status: 'archived',
			createdBy: demoUser.id,
		},
	])
	.returning()

const insight1 = unwrap(rawInsight1, 'insight1')
const insight2 = unwrap(rawInsight2, 'insight2')
const insight3 = unwrap(rawInsight3, 'insight3')

// ── Bets ────────────────────────────────────────────────────────────────────

const [rawBet1, rawBet2] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'bet',
			title: 'Simplify onboarding to 2 steps',
			content: 'Merge team-invite into post-signup flow to reduce drop-off.',
			status: 'active',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'bet',
			title: 'Add command palette',
			content: 'Expose all actions via Cmd+K palette for power users.',
			status: 'proposed',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
	])
	.returning()

const bet1 = unwrap(rawBet1, 'bet1')
const bet2 = unwrap(rawBet2, 'bet2')

// ── Tasks ───────────────────────────────────────────────────────────────────

const [rawTask1, rawTask2, rawTask3] = await db
	.insert(objects)
	.values([
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Remove team-invite step from onboarding',
			status: 'in_progress',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Design command palette UI',
			status: 'todo',
			owner: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Investigate API caching strategy',
			status: 'todo',
			createdBy: demoUser.id,
		},
	])
	.returning()

const task1 = unwrap(rawTask1, 'task1')
const task2 = unwrap(rawTask2, 'task2')
const task3 = unwrap(rawTask3, 'task3')

// ── Relationships ───────────────────────────────────────────────────────────

await db.insert(relationships).values([
	{
		sourceType: 'insight',
		sourceId: insight1.id,
		targetType: 'bet',
		targetId: bet1.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'insight',
		sourceId: insight2.id,
		targetType: 'bet',
		targetId: bet2.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet1.id,
		targetType: 'task',
		targetId: task1.id,
		type: 'breaks_into',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'bet',
		sourceId: bet2.id,
		targetType: 'task',
		targetId: task2.id,
		type: 'breaks_into',
		createdBy: demoUser.id,
	},
	{
		sourceType: 'insight',
		sourceId: insight3.id,
		targetType: 'task',
		targetId: task3.id,
		type: 'informs',
		createdBy: demoUser.id,
	},
])

// ── Triggers ───────────────────────────────────────────────────────────────

// Create event trigger: when new insights arrive, run clusterer
await db.insert(triggers).values({
	workspaceId: demoWorkspace.id,
	name: 'Cluster new insights',
	type: 'event',
	config: { entity_type: 'insight', action: 'created' },
	actionPrompt:
		'New insights have been created. Review all insights with status "new" and cluster them into bets.',
	targetActorId: clusterer.id,
	enabled: true,
	createdBy: demoUser.id,
})

// Create event trigger: when bet becomes active, decompose into tasks
await db.insert(triggers).values({
	workspaceId: demoWorkspace.id,
	name: 'Decompose active bets',
	type: 'event',
	config: { entity_type: 'bet', action: 'status_changed', filter: { status: 'active' } },
	actionPrompt: 'A bet has been promoted to active. Break it down into actionable tasks.',
	targetActorId: decomposer.id,
	enabled: true,
	createdBy: demoUser.id,
})

// ── Notifications ─────────────────────────────────────────────────────────

await db.insert(notifications).values([
	{
		workspaceId: demoWorkspace.id,
		type: 'needs_input',
		title: 'Benchmarking pricing — I need a direction',
		content:
			"I drafted the competitive positioning doc and modeled three pricing approaches. Can't move forward on GTM without knowing which direction.",
		metadata: {
			urgency_label: 'Needs you now',
			meta_text: 'Waiting 2 days · 4 downstream tasks blocked',
			question: 'Which pricing model should I build the GTM plan around?',
			options: [
				{
					label: 'Freemium → Paid',
					value: 'freemium',
					description: 'Lower barrier, longer conversion',
				},
				{ label: 'Bundle with Pro', value: 'bundle', description: 'Higher ARPU, limits reach' },
				{ label: 'Test both', value: 'test_both', description: 'A/B test with cohort split' },
			],
			tags: ['Data Benchmarking MVP', 'Competitive Positioning Draft', 'GTM plan — blocked'],
		},
		sourceActorId: clusterer.id,
		targetActorId: demoUser.id,
		objectId: bet1.id,
		status: 'pending',
	},
	{
		workspaceId: demoWorkspace.id,
		type: 'recommendation',
		title: 'Churn signal clustering around data exports',
		content:
			'Three customer calls this week mentioned "data export limitations" as a blocker. Cross-referenced with support tickets and NPS — same theme.',
		metadata: {
			urgency_label: 'Needs you now',
			meta_text: '7 mentions in 14 days · accelerating',
			tags: ['Data export friction ×7', '3 customer calls', 'Q3 renewal risk — 4 accounts'],
			suggestion:
				'I think this warrants a new bet. Want me to draft one with the insights attached?',
		},
		sourceActorId: clusterer.id,
		targetActorId: demoUser.id,
		status: 'pending',
	},
	{
		workspaceId: demoWorkspace.id,
		type: 'good_news',
		title: 'Onboarding flow bet completed successfully',
		content:
			'All 6 tasks under the "Simplify onboarding" bet are done. Conversion rate up 12% in the last 7 days.',
		metadata: {
			tags: ['+12% conversion', '6/6 tasks done'],
		},
		sourceActorId: decomposer.id,
		targetActorId: demoUser.id,
		objectId: bet1.id,
		status: 'seen',
	},
	{
		workspaceId: demoWorkspace.id,
		type: 'alert',
		title: '2 tasks blocked for 3+ days',
		content:
			'"API rate limit research" and "Competitor pricing analysis" haven\'t progressed. Both are blocked on external data access.',
		metadata: {
			urgency_label: '2 items stuck',
			meta_text: 'First blocked 5 days ago',
			tags: ['API rate limit research', 'Competitor pricing analysis'],
		},
		sourceActorId: decomposer.id,
		targetActorId: demoUser.id,
		status: 'pending',
	},
])

console.log('Seed complete')
process.exit(0)
