import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	catalogPackageItems,
	catalogPackages,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
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
	SINDRE_DEFAULT,
} from '@maskin/shared'
import { and, count, eq, isNotNull } from 'drizzle-orm'

/**
 * Seeds the global catalog with the Customer Continuous Discovery package if
 * the catalog_packages table is empty. Safe to call on every startup — the
 * count check makes it a no-op once any package exists.
 */
export async function seedCatalogIfEmpty(db: Database): Promise<void> {
	const [row] = await db.select({ n: count() }).from(catalogPackages)
	if (row && row.n > 0) return

	const [pkg] = await db
		.insert(catalogPackages)
		.values({
			slug: CCD_PACKAGE_SLUG,
			name: CCD_PACKAGE_NAME,
			description: CCD_PACKAGE_DESCRIPTION,
			version: CCD_PACKAGE_VERSION,
			useCase: CCD_PACKAGE_USE_CASE,
		})
		.returning()

	if (!pkg) return

	await db.insert(catalogPackageItems).values([
		{
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
		{
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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
			packageId: pkg.id,
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

export interface DevBootstrapResult {
	apiKey: string
	workspaceId: string
	actorName: string
	actorEmail: string
	workspaceName: string
	/** True when this run actually created the records (fresh DB). */
	created: boolean
}

/**
 * Returns ready-to-run dev credentials:
 * - On an empty database, creates a default actor + workspace + API key.
 * - On an existing database, looks up the first actor that has an API key and
 *   a workspace they're a member of, so the startup banner can still show a
 *   working `claude mcp add` command without the user hunting in the UI.
 *
 * Skipped in production or when MASKIN_AUTO_BOOTSTRAP=false.
 */
export async function maybeBootstrapDev(db: Database): Promise<DevBootstrapResult | null> {
	if (process.env.NODE_ENV === 'production') return null
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return null

	const existing = await findExistingCredentials(db)
	if (existing) return existing

	const { key } = generateApiKey()
	const [actor] = await db
		.insert(actors)
		.values({
			type: 'human',
			name: 'You',
			email: 'dev@local',
			apiKey: key,
		})
		.returning()

	if (!actor) throw new Error('dev bootstrap: failed to create actor')

	const workspace = await db.transaction(async (tx) => {
		const [ws] = await tx
			.insert(workspaces)
			.values({
				name: 'My Workspace',
				createdBy: actor.id,
			})
			.returning()

		if (!ws) return null

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: actor.id,
			role: 'owner',
		})

		// Seed Sindre — the built-in meta-agent shipped with every workspace.
		// apiKey is required (see comment in actors.ts) — without it the agent's
		// container has no identity to authenticate MCP writes with.
		const [sindre] = await tx
			.insert(actors)
			.values({
				type: SINDRE_DEFAULT.type,
				name: SINDRE_DEFAULT.name,
				isSystem: SINDRE_DEFAULT.isSystem,
				systemPrompt: SINDRE_DEFAULT.systemPrompt,
				llmProvider: SINDRE_DEFAULT.llmProvider,
				llmConfig: SINDRE_DEFAULT.llmConfig,
				tools: SINDRE_DEFAULT.tools,
				apiKey: generateApiKey().key,
				createdBy: actor.id,
			})
			.returning()

		if (!sindre) throw new Error('dev bootstrap: failed to seed Sindre actor')

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: sindre.id,
			role: 'member',
		})

		return ws
	})

	if (!workspace) throw new Error('dev bootstrap: failed to create workspace')

	return {
		apiKey: key,
		workspaceId: workspace.id,
		actorName: actor.name ?? 'You',
		actorEmail: actor.email ?? 'dev@local',
		workspaceName: workspace.name,
		created: true,
	}
}

async function findExistingCredentials(db: Database): Promise<DevBootstrapResult | null> {
	const [row] = await db
		.select({
			apiKey: actors.apiKey,
			actorName: actors.name,
			actorEmail: actors.email,
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
		})
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(and(isNotNull(actors.apiKey), eq(actors.type, 'human')))
		.limit(1)

	if (!row || !row.apiKey) return null
	return {
		apiKey: row.apiKey,
		workspaceId: row.workspaceId,
		actorName: row.actorName ?? 'You',
		actorEmail: row.actorEmail ?? 'dev@local',
		workspaceName: row.workspaceName,
		created: false,
	}
}
