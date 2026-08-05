import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	catalogPackageItems,
	catalogPackages,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT, WORKSPACE_COACH_DEFAULT } from '@maskin/shared'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { AgentStorageManager } from '../services/agent-storage'
import { bootstrapDefaultAgents } from '../services/workspace-bootstrap'
import {
	CCD_ACTOR_IDS,
	CCD_PACKAGE,
	CCD_SKILL_IDS,
	CCD_TRIGGER_IDS,
} from './catalog-packages/ccd-package'
import {
	DEV_PIPELINE_ACTOR_IDS,
	DEV_PIPELINE_PACKAGE,
	DEV_PIPELINE_SKILL_IDS,
	DEV_PIPELINE_TRIGGER_IDS,
} from './catalog-packages/dev-pipeline-package'
import {
	type CatalogPackageSeedConfig,
	getActorData,
	getSkillData,
	getTriggerData,
} from './catalog-packages/package-data'
import { actorSnapshot, skillSnapshot, triggerSnapshot } from './catalog-packages/package-snapshot'
import {
	STRATEGY_GROWTH_ACTOR_IDS,
	STRATEGY_GROWTH_PACKAGE,
	STRATEGY_GROWTH_SKILL_IDS,
	STRATEGY_GROWTH_TRIGGER_IDS,
} from './catalog-packages/strategy-growth-package'
import {
	TEAM_OPS_ACTOR_IDS,
	TEAM_OPS_PACKAGE,
	TEAM_OPS_SKILL_IDS,
	TEAM_OPS_TRIGGER_IDS,
} from './catalog-packages/team-ops-package'
import { logger } from './logger'

const CATALOG_SEED_CONFIGS: readonly CatalogPackageSeedConfig[] = [
	{
		package: CCD_PACKAGE,
		actorIds: CCD_ACTOR_IDS,
		triggerIds: CCD_TRIGGER_IDS,
		skillIds: CCD_SKILL_IDS,
	},
	{
		package: DEV_PIPELINE_PACKAGE,
		actorIds: DEV_PIPELINE_ACTOR_IDS,
		triggerIds: DEV_PIPELINE_TRIGGER_IDS,
		skillIds: DEV_PIPELINE_SKILL_IDS,
	},
	{
		package: STRATEGY_GROWTH_PACKAGE,
		actorIds: STRATEGY_GROWTH_ACTOR_IDS,
		triggerIds: STRATEGY_GROWTH_TRIGGER_IDS,
		skillIds: STRATEGY_GROWTH_SKILL_IDS,
	},
	{
		package: TEAM_OPS_PACKAGE,
		actorIds: TEAM_OPS_ACTOR_IDS,
		triggerIds: TEAM_OPS_TRIGGER_IDS,
		skillIds: TEAM_OPS_SKILL_IDS,
	},
]

export interface CatalogSyncResult {
	inserted: string[]
	updated: string[]
	unchanged: string[]
}

/**
 * Syncs the global catalog with the four installable Loop bundles (Discover &
 * Research, Build & Ship, Strategy & Growth, Team Ops & Retro), upserting by
 * slug. A package missing from catalog_packages is inserted; a package whose
 * code-defined version differs from the stored row is updated in place (its
 * catalog_package_items are replaced wholesale); a package whose version
 * matches is left untouched. Safe to call on every startup/deploy.
 *
 * Bumping a package's `version` is the deliberate signal that propagates a
 * change: `PackageVersionPusher` (services/package-version-pusher.ts) polls
 * hourly for installed_packages rows whose installedVersion has fallen behind
 * catalogPackages.version and re-provisions locked installs accordingly.
 *
 * Reuses the exact same package configs + snapshot data the publish-*.ts
 * scripts publish to a shared catalog DB, so local dev never drifts from what
 * those scripts ship (see apps/dev/src/lib/catalog-packages/).
 *
 * No env guards here — production seeding goes through this function too, via
 * `scripts/seed-catalog.ts` (wired into the Docker boot sequence). Env-gating
 * lives in `seedCatalogIfEmpty` below, the dev-server-boot entrypoint.
 */
export async function seedCatalogPackages(db: Database): Promise<CatalogSyncResult> {
	const existingRows = await db
		.select({
			id: catalogPackages.id,
			slug: catalogPackages.slug,
			version: catalogPackages.version,
		})
		.from(catalogPackages)
	const existingBySlug = new Map(existingRows.map((r) => [r.slug, r]))

	const inserted: string[] = []
	const updated: string[] = []
	const unchanged: string[] = []

	await db.transaction(async (tx) => {
		for (const config of CATALOG_SEED_CONFIGS) {
			const existing = existingBySlug.get(config.package.slug)
			if (existing && existing.version === config.package.version) {
				unchanged.push(config.package.slug)
				continue
			}

			const actorRows = config.actorIds.map(getActorData)
			const triggerRows = config.triggerIds.map(getTriggerData)
			const skillRows = config.skillIds.map(getSkillData)

			const publishedActorIds = new Set<string>(config.actorIds)
			for (const t of triggerRows) {
				if (!publishedActorIds.has(t.targetActorId)) {
					throw new Error(
						`${config.package.slug}: trigger ${t.id} (${t.name}) targets actor ${t.targetActorId}, which is not in the seeded actor set.`,
					)
				}
			}

			let packageId: string
			if (existing) {
				await tx
					.update(catalogPackages)
					.set({
						name: config.package.name,
						description: config.package.description,
						version: config.package.version,
						useCase: config.package.useCase,
						updatedAt: new Date(),
					})
					.where(eq(catalogPackages.id, existing.id))
				await tx.delete(catalogPackageItems).where(eq(catalogPackageItems.packageId, existing.id))
				packageId = existing.id
				updated.push(config.package.slug)
			} else {
				const [pkg] = await tx
					.insert(catalogPackages)
					.values({
						slug: config.package.slug,
						name: config.package.name,
						description: config.package.description,
						version: config.package.version,
						useCase: config.package.useCase,
					})
					.returning()

				if (!pkg) throw new Error(`${config.package.slug}: catalog_packages insert returned no row`)
				packageId = pkg.id
				inserted.push(config.package.slug)
			}

			await tx.insert(catalogPackageItems).values([
				...actorRows.map((actorRow) => ({
					packageId,
					itemType: 'actor' as const,
					sourceItemId: actorRow.id,
					itemSnapshot: actorSnapshot(actorRow),
				})),
				...triggerRows.map((triggerRow) => ({
					packageId,
					itemType: 'trigger' as const,
					sourceItemId: triggerRow.id,
					itemSnapshot: triggerSnapshot(triggerRow),
				})),
				...skillRows.map((skillRow) => ({
					packageId,
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
 * Dev-server-boot entrypoint for catalog seeding — called unconditionally from
 * index.ts on every startup, so it no-ops itself outside local dev. Production
 * seeding is a deliberate, separate step: see `seedCatalogPackages` above.
 */
export async function seedCatalogIfEmpty(db: Database): Promise<void> {
	if (process.env.NODE_ENV === 'production') return
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return

	await seedCatalogPackages(db)
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

		// Seed Workspace Coach — the built-in meta-agent shipped with every workspace.
		// apiKey is required (see comment in actors.ts) — without it the agent's
		// container has no identity to authenticate MCP writes with.
		const [coach] = await tx
			.insert(actors)
			.values({
				type: WORKSPACE_COACH_DEFAULT.type,
				name: WORKSPACE_COACH_DEFAULT.name,
				isSystem: WORKSPACE_COACH_DEFAULT.isSystem,
				systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
				llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
				llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig,
				tools: WORKSPACE_COACH_DEFAULT.tools,
				apiKey: generateApiKey().key,
				createdBy: actor.id,
			})
			.returning()

		if (!coach) throw new Error('dev bootstrap: failed to seed Workspace Coach actor')

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: coach.id,
			role: 'member',
		})

		// Seed Chief of Staff synchronously so we can capture its actor id and
		// pin it as this workspace's default chat agent in the same tx.
		// bootstrapDefaultAgents() also has an idempotent CoS name-check so the
		// post-commit call will simply skip this actor.
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

	// Seed Driver and Strategist async (Workspace Coach was already seeded above).
	// bootstrapDefaultAgents is idempotent — it skips Workspace Coach by name.
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
