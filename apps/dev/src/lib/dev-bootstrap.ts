import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	marketplaceLoopItems,
	marketplaceLoops,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { AgentStorageManager } from '../services/agent-storage'
import { bootstrapDefaultAgents } from '../services/workspace-bootstrap'
import { logger } from './logger'
import {
	CCD_ACTOR_IDS,
	CCD_LOOP,
	CCD_SKILL_IDS,
	CCD_TRIGGER_IDS,
} from './marketplace-loops/ccd-loop'
import {
	DEV_PIPELINE_ACTOR_IDS,
	DEV_PIPELINE_LOOP,
	DEV_PIPELINE_SKILL_IDS,
	DEV_PIPELINE_TRIGGER_IDS,
} from './marketplace-loops/dev-pipeline-loop'
import {
	GROWTH_BET_ACTOR_IDS,
	GROWTH_BET_LOOP,
	GROWTH_BET_SKILL_IDS,
	GROWTH_BET_TRIGGER_IDS,
} from './marketplace-loops/growth-bet-loop'
import {
	GROWTH_BRAND_DEMAND_ACTOR_IDS,
	GROWTH_BRAND_DEMAND_LOOP,
	GROWTH_BRAND_DEMAND_SKILL_IDS,
	GROWTH_BRAND_DEMAND_TRIGGER_IDS,
} from './marketplace-loops/growth-brand-demand-loop'
import {
	GROWTH_CONTENT_INSIGHT_ACTOR_IDS,
	GROWTH_CONTENT_INSIGHT_LOOP,
	GROWTH_CONTENT_INSIGHT_SKILL_IDS,
	GROWTH_CONTENT_INSIGHT_TRIGGER_IDS,
} from './marketplace-loops/growth-content-insight-loop'
import {
	GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS,
	GROWTH_DEAL_RELATIONSHIP_LOOP,
	GROWTH_DEAL_RELATIONSHIP_SKILL_IDS,
	GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS,
} from './marketplace-loops/growth-deal-relationship-loop'
import {
	GROWTH_LEAD_GEN_ACTOR_IDS,
	GROWTH_LEAD_GEN_LOOP,
	GROWTH_LEAD_GEN_SKILL_IDS,
	GROWTH_LEAD_GEN_TRIGGER_IDS,
} from './marketplace-loops/growth-lead-gen-loop'
import {
	GROWTH_MEETING_ACTOR_IDS,
	GROWTH_MEETING_LOOP,
	GROWTH_MEETING_SKILL_IDS,
	GROWTH_MEETING_TRIGGER_IDS,
} from './marketplace-loops/growth-meeting-loop'
import {
	GROWTH_OPS_KNOWLEDGE_ACTOR_IDS,
	GROWTH_OPS_KNOWLEDGE_LOOP,
	GROWTH_OPS_KNOWLEDGE_SKILL_IDS,
	GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS,
} from './marketplace-loops/growth-ops-knowledge-loop'
import {
	GROWTH_SDR_OUTREACH_ACTOR_IDS,
	GROWTH_SDR_OUTREACH_LOOP,
	GROWTH_SDR_OUTREACH_SKILL_IDS,
	GROWTH_SDR_OUTREACH_TRIGGER_IDS,
} from './marketplace-loops/growth-sdr-outreach-loop'
import {
	type MarketplaceLoopSeedConfig,
	getActorData,
	getSkillData,
	getTriggerData,
} from './marketplace-loops/loop-data'
import { actorSnapshot, skillSnapshot, triggerSnapshot } from './marketplace-loops/loop-snapshot'
import {
	STRATEGY_GROWTH_ACTOR_IDS,
	STRATEGY_GROWTH_LOOP,
	STRATEGY_GROWTH_SKILL_IDS,
	STRATEGY_GROWTH_TRIGGER_IDS,
} from './marketplace-loops/strategy-growth-loop'
import {
	TEAM_OPS_ACTOR_IDS,
	TEAM_OPS_LOOP,
	TEAM_OPS_SKILL_IDS,
	TEAM_OPS_TRIGGER_IDS,
} from './marketplace-loops/team-ops-loop'

const MARKETPLACE_SEED_CONFIGS: readonly MarketplaceLoopSeedConfig[] = [
	{
		loop: CCD_LOOP,
		actorIds: CCD_ACTOR_IDS,
		triggerIds: CCD_TRIGGER_IDS,
		skillIds: CCD_SKILL_IDS,
	},
	{
		loop: DEV_PIPELINE_LOOP,
		actorIds: DEV_PIPELINE_ACTOR_IDS,
		triggerIds: DEV_PIPELINE_TRIGGER_IDS,
		skillIds: DEV_PIPELINE_SKILL_IDS,
	},
	{
		loop: STRATEGY_GROWTH_LOOP,
		actorIds: STRATEGY_GROWTH_ACTOR_IDS,
		triggerIds: STRATEGY_GROWTH_TRIGGER_IDS,
		skillIds: STRATEGY_GROWTH_SKILL_IDS,
	},
	{
		loop: TEAM_OPS_LOOP,
		actorIds: TEAM_OPS_ACTOR_IDS,
		triggerIds: TEAM_OPS_TRIGGER_IDS,
		skillIds: TEAM_OPS_SKILL_IDS,
	},
	{
		loop: GROWTH_LEAD_GEN_LOOP,
		actorIds: GROWTH_LEAD_GEN_ACTOR_IDS,
		triggerIds: GROWTH_LEAD_GEN_TRIGGER_IDS,
		skillIds: GROWTH_LEAD_GEN_SKILL_IDS,
	},
	{
		loop: GROWTH_SDR_OUTREACH_LOOP,
		actorIds: GROWTH_SDR_OUTREACH_ACTOR_IDS,
		triggerIds: GROWTH_SDR_OUTREACH_TRIGGER_IDS,
		skillIds: GROWTH_SDR_OUTREACH_SKILL_IDS,
	},
	{
		loop: GROWTH_DEAL_RELATIONSHIP_LOOP,
		actorIds: GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS,
		triggerIds: GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS,
		skillIds: GROWTH_DEAL_RELATIONSHIP_SKILL_IDS,
	},
	{
		loop: GROWTH_CONTENT_INSIGHT_LOOP,
		actorIds: GROWTH_CONTENT_INSIGHT_ACTOR_IDS,
		triggerIds: GROWTH_CONTENT_INSIGHT_TRIGGER_IDS,
		skillIds: GROWTH_CONTENT_INSIGHT_SKILL_IDS,
	},
	{
		loop: GROWTH_BRAND_DEMAND_LOOP,
		actorIds: GROWTH_BRAND_DEMAND_ACTOR_IDS,
		triggerIds: GROWTH_BRAND_DEMAND_TRIGGER_IDS,
		skillIds: GROWTH_BRAND_DEMAND_SKILL_IDS,
	},
	{
		loop: GROWTH_BET_LOOP,
		actorIds: GROWTH_BET_ACTOR_IDS,
		triggerIds: GROWTH_BET_TRIGGER_IDS,
		skillIds: GROWTH_BET_SKILL_IDS,
	},
	{
		loop: GROWTH_OPS_KNOWLEDGE_LOOP,
		actorIds: GROWTH_OPS_KNOWLEDGE_ACTOR_IDS,
		triggerIds: GROWTH_OPS_KNOWLEDGE_TRIGGER_IDS,
		skillIds: GROWTH_OPS_KNOWLEDGE_SKILL_IDS,
	},
	{
		loop: GROWTH_MEETING_LOOP,
		actorIds: GROWTH_MEETING_ACTOR_IDS,
		triggerIds: GROWTH_MEETING_TRIGGER_IDS,
		skillIds: GROWTH_MEETING_SKILL_IDS,
	},
]

export interface MarketplaceSyncResult {
	inserted: string[]
	updated: string[]
	unchanged: string[]
}

/**
 * Syncs the global marketplace with the installable Loop bundles (Discover &
 * Research, Build & Ship, Strategy & Growth, Team Ops & Retro), upserting by
 * slug. A loop missing from marketplace_loops is inserted; a loop whose
 * code-defined version differs from the stored row is updated in place (its
 * marketplace_loop_items are replaced wholesale); a loop whose version
 * matches is left untouched. Safe to call on every startup/deploy.
 *
 * Bumping a loop's `version` is the deliberate signal that propagates a
 * change: `LoopVersionPusher` (services/loop-version-pusher.ts) polls
 * hourly for installed_loops rows whose installedVersion has fallen behind
 * marketplaceLoops.version and re-provisions locked installs accordingly.
 *
 * Reuses the exact same loop configs + snapshot data the publish-*.ts
 * scripts publish to a shared marketplace DB, so local dev never drifts from what
 * those scripts ship (see apps/dev/src/lib/marketplace-loops/).
 *
 * No env guards here — production seeding goes through this function too, via
 * `scripts/seed-marketplace.ts` (wired into the Docker boot sequence). Env-gating
 * lives in `seedMarketplaceIfEmpty` below, the dev-server-boot entrypoint.
 */
export async function seedMarketplaceLoops(db: Database): Promise<MarketplaceSyncResult> {
	const existingRows = await db
		.select({
			id: marketplaceLoops.id,
			slug: marketplaceLoops.slug,
			version: marketplaceLoops.version,
		})
		.from(marketplaceLoops)
	const existingBySlug = new Map(existingRows.map((r) => [r.slug, r]))

	const inserted: string[] = []
	const updated: string[] = []
	const unchanged: string[] = []

	await db.transaction(async (tx) => {
		for (const config of MARKETPLACE_SEED_CONFIGS) {
			const existing = existingBySlug.get(config.loop.slug)
			if (existing && existing.version === config.loop.version) {
				unchanged.push(config.loop.slug)
				continue
			}

			const actorRows = config.actorIds.map(getActorData)
			const triggerRows = config.triggerIds.map(getTriggerData)
			const skillRows = config.skillIds.map(getSkillData)

			const publishedActorIds = new Set<string>(config.actorIds)
			for (const t of triggerRows) {
				if (!publishedActorIds.has(t.targetActorId)) {
					throw new Error(
						`${config.loop.slug}: trigger ${t.id} (${t.name}) targets actor ${t.targetActorId}, which is not in the seeded actor set.`,
					)
				}
			}

			let loopId: string
			if (existing) {
				await tx
					.update(marketplaceLoops)
					.set({
						name: config.loop.name,
						description: config.loop.description,
						version: config.loop.version,
						useCase: config.loop.useCase,
						updatedAt: new Date(),
					})
					.where(eq(marketplaceLoops.id, existing.id))
				await tx.delete(marketplaceLoopItems).where(eq(marketplaceLoopItems.loopId, existing.id))
				loopId = existing.id
				updated.push(config.loop.slug)
			} else {
				const [loop] = await tx
					.insert(marketplaceLoops)
					.values({
						slug: config.loop.slug,
						name: config.loop.name,
						description: config.loop.description,
						version: config.loop.version,
						useCase: config.loop.useCase,
					})
					.returning()

				if (!loop) throw new Error(`${config.loop.slug}: marketplace_loops insert returned no row`)
				loopId = loop.id
				inserted.push(config.loop.slug)
			}

			await tx.insert(marketplaceLoopItems).values([
				...actorRows.map((actorRow) => ({
					loopId,
					itemType: 'actor' as const,
					sourceItemId: actorRow.id,
					itemSnapshot: actorSnapshot(actorRow),
				})),
				...triggerRows.map((triggerRow) => ({
					loopId,
					itemType: 'trigger' as const,
					sourceItemId: triggerRow.id,
					itemSnapshot: triggerSnapshot(triggerRow),
				})),
				...skillRows.map((skillRow) => ({
					loopId,
					itemType: 'skill' as const,
					sourceItemId: skillRow.id,
					itemSnapshot: skillSnapshot(
						skillRow,
						skillRow.attachedActorIds.filter((id) => publishedActorIds.has(id)),
					),
				})),
			])
		}
	})

	return { inserted, updated, unchanged }
}

/**
 * Dev-server-boot entrypoint for marketplace seeding — called unconditionally from
 * index.ts on every startup, so it no-ops itself outside local dev. Production
 * seeding is a deliberate, separate step: see `seedMarketplaceLoops` above.
 */
export async function seedMarketplaceIfEmpty(db: Database): Promise<void> {
	if (process.env.NODE_ENV === 'production') return
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return

	await seedMarketplaceLoops(db)
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
export async function maybeBootstrapDev(
	db: Database,
	agentStorage?: AgentStorageManager,
): Promise<DevBootstrapResult | null> {
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

		// Seed Chief of Staff — the only agent a new workspace starts with —
		// synchronously so we can capture its actor id and pin it as this
		// workspace's default chat agent in the same tx. bootstrapDefaultAgents()
		// also has an idempotent CoS name-check so the post-commit call will
		// simply skip this actor. apiKey is required (see comment in actors.ts) —
		// without it the agent's container has no identity to authenticate MCP
		// writes with.
		const [chief] = await tx
			.insert(actors)
			.values({
				type: CHIEF_OF_STAFF_DEFAULT.type,
				name: CHIEF_OF_STAFF_DEFAULT.name,
				isSystem: CHIEF_OF_STAFF_DEFAULT.isSystem,
				systemPrompt: CHIEF_OF_STAFF_DEFAULT.systemPrompt,
				llmProvider: CHIEF_OF_STAFF_DEFAULT.llmProvider,
				llmConfig: CHIEF_OF_STAFF_DEFAULT.llmConfig,
				tools: CHIEF_OF_STAFF_DEFAULT.tools,
				apiKey: generateApiKey().key,
				createdBy: actor.id,
			})
			.returning()

		if (!chief) throw new Error('dev bootstrap: failed to seed Chief of Staff actor')

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: chief.id,
			role: 'member',
		})

		// Pin Chief of Staff as the default chat agent for this workspace.
		// Reversible via `pnpm --filter @maskin/dev exec tsx scripts/seed-default-agent.ts --unset`.
		await tx
			.update(workspaces)
			.set({ settings: { default_agent_id: chief.id } })
			.where(eq(workspaces.id, ws.id))

		return ws
	})

	if (!workspace) throw new Error('dev bootstrap: failed to create workspace')

	// Safety net for the default-agent set (Chief of Staff was already seeded
	// above). bootstrapDefaultAgents is idempotent — it skips actors by name.
	if (agentStorage) {
		bootstrapDefaultAgents(db, agentStorage, workspace.id, actor.id).catch((err) =>
			logger.error('dev bootstrap: default agent seeding failed', {
				workspaceId: workspace.id,
				err,
			}),
		)
	}

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
