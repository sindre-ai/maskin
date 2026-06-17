import { randomUUID } from 'node:crypto'
import {
	CCD_ACTOR_CUSTOMER_CURATOR,
	CCD_ACTOR_CUSTOMER_FEEDBACK,
	CCD_ACTOR_INSIGHTS_TRIAGE,
	CCD_ACTOR_PRODUCT_IDEATOR,
	CCD_PACKAGE_DESCRIPTION,
	CCD_PACKAGE_NAME,
	CCD_PACKAGE_SLUG,
	CCD_PACKAGE_USE_CASE,
	CCD_PACKAGE_VERSION,
	DISCOVERY_CATEGORY,
	JOB_LOOP_CATEGORY,
	JOB_LOOP_PACKAGES,
	JOB_LOOP_PACKAGE_VERSION,
	KNOWLEDGE_NUDGES,
} from '@maskin/shared'
import { createDb } from './connection'
import {
	actors,
	catalogPackageItems,
	catalogPackages,
	notifications,
	objects,
	relationships,
	triggers,
	workspaceMembers,
	workspaces,
} from './schema'

// Inlined to avoid a circular dep with @maskin/auth (which depends on @maskin/db).
// Mirrors generateApiKey() in packages/auth/src/api-keys.ts.
const newApiKey = () => `ank_${randomUUID().replace(/-/g, '')}`

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
		apiKey: newApiKey(),
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
		systemPrompt: `${KNOWLEDGE_NUDGES}

You are an AI agent that analyzes insights and clusters them into bets.

When triggered, review all new/unprocessed insights in the workspace. Look for patterns, themes, and recurring signals. Group related insights together and create "bet" objects that represent strategic opportunities or problems worth addressing.

For each bet you create:
1. Give it a clear, actionable title
2. Write a summary in the content field explaining the pattern you identified
3. Set status to "signal"
4. Create "informs" relationships from each source insight to the bet
5. Update processed insights to status "clustered"

Use the update_memory tool to track which insights you've already processed.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-opus-4-7', temperature: 0.3 },
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
		apiKey: newApiKey(),
	})
	.returning()

const clusterer = unwrap(rawClusterer, 'clusterer')

// Create Bet Decomposer agent
const [rawDecomposer] = await db
	.insert(actors)
	.values({
		type: 'agent',
		name: 'Bet Decomposer',
		systemPrompt: `${KNOWLEDGE_NUDGES}

You are an AI agent that breaks down active bets into actionable tasks.

When a bet is promoted to "active" status, analyze it and create a set of concrete, actionable tasks that would move the bet forward. Each task should be:
1. Specific and actionable (not vague)
2. Small enough to complete in 1-3 days
3. Clearly titled
4. Set to status "todo"
5. Connected to the bet via a "breaks_into" relationship

Consider the bet's content, any related insights, and what a product team would need to do to act on this opportunity.`,
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-opus-4-7', temperature: 0.3 },
		tools: {
			allowed: ['create_object', 'list_objects', 'create_relationship', 'update_memory', 'done'],
		},
		apiKey: newApiKey(),
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
			driver: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'bet',
			title: 'Add command palette',
			content: 'Expose all actions via Cmd+K palette for power users.',
			status: 'proposed',
			driver: demoUser.id,
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
			driver: demoUser.id,
			createdBy: demoUser.id,
		},
		{
			workspaceId: demoWorkspace.id,
			type: 'task',
			title: 'Design command palette UI',
			status: 'todo',
			driver: demoUser.id,
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

// ── Catalog Packages ──────────────────────────────────────────────────────────
//
// Static snapshot of the Customer Continuous Discovery package so the
// marketplace has something to show in a fresh dev environment. The
// source_item_id values match CCD_ACTOR_IDS / CCD_TRIGGER_IDS in
// apps/dev/scripts/ccd-package.ts — the install provisioner uses them to
// resolve intra-package wiring (trigger.targetActorId → installed actor).

const [ccdPkg] = await db
	.insert(catalogPackages)
	.values({
		slug: CCD_PACKAGE_SLUG,
		name: CCD_PACKAGE_NAME,
		description: CCD_PACKAGE_DESCRIPTION,
		version: CCD_PACKAGE_VERSION,
		useCase: CCD_PACKAGE_USE_CASE,
		category: DISCOVERY_CATEGORY,
	})
	.returning()

if (ccdPkg) {
	await db.insert(catalogPackageItems).values([
		// Actors
		{
			packageId: ccdPkg.id,
			itemType: 'actor',
			sourceItemId: CCD_ACTOR_CUSTOMER_FEEDBACK,
			itemSnapshot: {
				type: 'agent',
				name: 'Customer Feedback Agent',
				description: 'Ingests and normalises raw customer feedback from all connected channels.',
				systemPrompt:
					'You are the Customer Feedback Agent. Your job is to ingest raw feedback from connected integrations (Slack, email, support tools), normalise it into structured insights, and store them so the Insights Triage Agent can act on them.',
				llmProvider: 'anthropic',
				llmConfig: { model: 'claude-opus-4-8', temperature: 0.2 },
				tools: {
					allowed: ['create_object', 'update_object', 'list_objects', 'update_memory', 'done'],
				},
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'actor',
			sourceItemId: CCD_ACTOR_INSIGHTS_TRIAGE,
			itemSnapshot: {
				type: 'agent',
				name: 'Insights Triage Agent',
				description: 'Clusters incoming insights and surfaces patterns as bets.',
				systemPrompt:
					'You are the Insights Triage Agent. When triggered, review all new insights, cluster them by theme, and create or update bet objects that represent the underlying product opportunities.',
				llmProvider: 'anthropic',
				llmConfig: { model: 'claude-opus-4-8', temperature: 0.3 },
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
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'actor',
			sourceItemId: CCD_ACTOR_PRODUCT_IDEATOR,
			itemSnapshot: {
				type: 'agent',
				name: 'Product Ideator',
				description: 'Generates bet candidates from clustered insight patterns.',
				systemPrompt:
					'You are the Product Ideator. Each day you review recently clustered insights and propose up to three concrete bet candidates the team should consider, with a short rationale for each.',
				llmProvider: 'anthropic',
				llmConfig: { model: 'claude-opus-4-8', temperature: 0.5 },
				tools: {
					allowed: [
						'create_object',
						'list_objects',
						'create_relationship',
						'update_memory',
						'done',
					],
				},
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'actor',
			sourceItemId: CCD_ACTOR_CUSTOMER_CURATOR,
			itemSnapshot: {
				type: 'agent',
				name: 'Customer Curator',
				description: 'Closes the loop by sending personalised replies to customers.',
				systemPrompt:
					'You are the Customer Curator. After a bet is confirmed or a bug fix ships, find the customers whose feedback led to it and send them a personalised update via the connected channel.',
				llmProvider: 'anthropic',
				llmConfig: { model: 'claude-opus-4-8', temperature: 0.4 },
				tools: { allowed: ['list_objects', 'list_relationships', 'update_memory', 'done'] },
			},
		},
		// Triggers
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'f1d1c055-432f-462a-a177-f27ae7bc5c0e',
			itemSnapshot: {
				name: 'Bug Fix Merged → Reply in Slack',
				description: 'Notifies customers via Slack when a bug they reported has shipped.',
				type: 'event',
				config: { entity_type: 'bet', action: 'status_changed', filter: { status: 'shipped' } },
				actionPrompt:
					'A bug-fix bet has shipped. Find all customers whose feedback contributed to it and send them a personalised Slack reply.',
				targetActorId: CCD_ACTOR_CUSTOMER_CURATOR,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: '34fa2aa8-75c0-4919-9170-27fed672528e',
			itemSnapshot: {
				name: 'Deploy Confirmed → Customer Reply',
				description: 'Sends personalised updates to customers when a related deploy goes live.',
				type: 'event',
				config: { entity_type: 'bet', action: 'status_changed', filter: { status: 'shipped' } },
				actionPrompt:
					'A deploy has been confirmed. Identify customers who reported related issues and send them a personalised update.',
				targetActorId: CCD_ACTOR_CUSTOMER_CURATOR,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'f41f513a-5a58-4ab2-aab3-83e002f2c3b7',
			itemSnapshot: {
				name: 'Insight Created → Synthesizer Triage',
				description: 'Runs triage on every new insight to update or create bets.',
				type: 'event',
				config: { entity_type: 'insight', action: 'created' },
				actionPrompt:
					'A new insight has been created. Review it alongside existing insights and update or create bets accordingly.',
				targetActorId: CCD_ACTOR_INSIGHTS_TRIAGE,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'a7470be0-05c7-46b9-a003-f48b43a1a6b4',
			itemSnapshot: {
				name: 'Insight Updated → Synthesizer Re-triage',
				description: 'Re-evaluates bets whenever an existing insight changes.',
				type: 'event',
				config: { entity_type: 'insight', action: 'updated' },
				actionPrompt:
					'An insight has been updated. Re-evaluate whether the change affects any existing bets or warrants a new one.',
				targetActorId: CCD_ACTOR_INSIGHTS_TRIAGE,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'd458e38d-d486-4da3-8c89-74f989b2f104',
			itemSnapshot: {
				name: 'Daily Synthesizer Sweep',
				description: 'Clusters unprocessed insights and flags new patterns every morning.',
				type: 'cron',
				config: { cron: '0 8 * * *' },
				actionPrompt:
					'Run a full sweep of all unprocessed insights. Cluster them, update existing bets, and flag any new patterns.',
				targetActorId: CCD_ACTOR_INSIGHTS_TRIAGE,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'b65382c4-0287-4aa8-a477-9a61296e5702',
			itemSnapshot: {
				name: 'Weekly Synthesizer Digest',
				description: "Summarises the week's top insight themes and new bets every Monday.",
				type: 'cron',
				config: { cron: '0 9 * * 1' },
				actionPrompt:
					'Produce a weekly digest of all insights created in the last 7 days. Summarise the top themes and any new bets created.',
				targetActorId: CCD_ACTOR_INSIGHTS_TRIAGE,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: '28c063e2-4a39-4f5a-883d-5f5ef6a29a9e',
			itemSnapshot: {
				name: 'Daily Product Ideation — 3 Bet Candidates',
				description: 'Proposes three new bet candidates from recent insights each morning.',
				type: 'cron',
				config: { cron: '0 10 * * *' },
				actionPrompt:
					'Review the most recent clustered insights and propose exactly three new bet candidates with a short rationale for each.',
				targetActorId: CCD_ACTOR_PRODUCT_IDEATOR,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: '6bcede7c-2095-43b7-b9a1-82aeceab340f',
			itemSnapshot: {
				name: 'Insight Clustered → Update Customer',
				description: "Lets customers know their feedback is being acted on when it's clustered.",
				type: 'event',
				config: {
					entity_type: 'insight',
					action: 'status_changed',
					filter: { status: 'clustered' },
				},
				actionPrompt:
					'An insight has just been clustered into a bet. Notify the customer who submitted it that their feedback is being acted on.',
				targetActorId: CCD_ACTOR_CUSTOMER_CURATOR,
				enabled: true,
			},
		},
		{
			packageId: ccdPkg.id,
			itemType: 'trigger',
			sourceItemId: 'a8862b32-31c2-4714-8c47-34d61d73aee2',
			itemSnapshot: {
				name: 'Daily Customer Roster Sweep',
				description:
					'Closes the loop with customers whose feedback was resolved in the last 24 hours.',
				type: 'cron',
				config: { cron: '0 7 * * *' },
				actionPrompt:
					'Scan all customers who have open feedback items. For any whose item was shipped or archived in the last 24 hours, send a personalised close-the-loop message.',
				targetActorId: CCD_ACTOR_CUSTOMER_CURATOR,
				enabled: true,
			},
		},
	])
}

// ── Job-Loop Catalog Packages ────────────────────────────────────────────────
//
// Four cross-functional job loops for the storefront: Bug triage, Launch,
// Standup, Incident. Names, descriptions, and item composition are
// placeholders today — T1 (curated picks) and T2 (final copy) replace them
// once those tasks ship. The packages are tagged with `JOB_LOOP_CATEGORY` so
// T4's storefront tab can filter to them.

for (const pkg of JOB_LOOP_PACKAGES) {
	const [row] = await db
		.insert(catalogPackages)
		.values({
			slug: pkg.slug,
			name: pkg.name,
			description: pkg.description,
			version: JOB_LOOP_PACKAGE_VERSION,
			useCase: pkg.useCase,
			category: JOB_LOOP_CATEGORY,
		})
		.returning()

	if (!row) continue

	if (pkg.items.length > 0) {
		await db.insert(catalogPackageItems).values(
			pkg.items.map((item) => ({
				packageId: row.id,
				itemType: item.itemType,
				sourceItemId: item.sourceItemId,
				itemSnapshot: item.itemSnapshot,
			})),
		)
	}
}

console.log('Seed complete')
process.exit(0)
