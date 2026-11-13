import { issueApiKey, issueLoginKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	marketplaceLoopItems,
	marketplaceLoops,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import { provisionWorkspace } from '../services/workspace-bootstrap'
import { emitWorkspaceFirstReady } from './analytics/install-telemetry'
import {
	DISCOVERY_ACTOR_IDS,
	DISCOVERY_LOOP,
	DISCOVERY_SKILL_IDS,
	DISCOVERY_TRIGGER_IDS,
} from './marketplace-loops/discovery-loop'
import {
	type MarketplaceLoopSeedConfig,
	getActorData,
	getSkillData,
	getTriggerData,
} from './marketplace-loops/loop-data'
import { actorSnapshot, skillSnapshot, triggerSnapshot } from './marketplace-loops/loop-snapshot'
import {
	MARKET_WATCH_ACTOR_IDS,
	MARKET_WATCH_LOOP,
	MARKET_WATCH_SKILL_IDS,
	MARKET_WATCH_TRIGGER_IDS,
} from './marketplace-loops/market-watch-loop'
import {
	MEETING_LOOP,
	MEETING_LOOP_ACTOR_IDS,
	MEETING_LOOP_SKILL_IDS,
	MEETING_LOOP_TRIGGER_IDS,
} from './marketplace-loops/meeting-loop'

const MARKETPLACE_SEED_CONFIGS: readonly MarketplaceLoopSeedConfig[] = [
	{
		loop: MARKET_WATCH_LOOP,
		actorIds: MARKET_WATCH_ACTOR_IDS,
		triggerIds: MARKET_WATCH_TRIGGER_IDS,
		skillIds: MARKET_WATCH_SKILL_IDS,
	},
	{
		loop: DISCOVERY_LOOP,
		actorIds: DISCOVERY_ACTOR_IDS,
		triggerIds: DISCOVERY_TRIGGER_IDS,
		skillIds: DISCOVERY_SKILL_IDS,
	},
	{
		loop: MEETING_LOOP,
		actorIds: MEETING_LOOP_ACTOR_IDS,
		triggerIds: MEETING_LOOP_TRIGGER_IDS,
		skillIds: MEETING_LOOP_SKILL_IDS,
	},
]

export interface MarketplaceSyncResult {
	inserted: string[]
	updated: string[]
	unchanged: string[]
	/** Slugs newly retired because they are no longer in the seed list. */
	retired: string[]
}

/**
 * Syncs the global marketplace with the installable Loop bundles (Product
 * Discovery, Market & Competitor Watch, Meeting Loop), upserting by slug. A loop missing from marketplace_loops is inserted; a loop whose
 * code-defined version differs from the stored row is updated in place (its
 * marketplace_loop_items are replaced wholesale); a loop whose version
 * matches is left untouched. Safe to call on every startup/deploy.
 *
 * A marketplace_loops row whose slug is no longer in the seed list is retired
 * (retired_at set), not deleted: installed_loops.source_loop_id has no ON DELETE
 * rule and the version pusher, installed list and uninstall all join on the row,
 * so existing installs must keep it. A retired slug that comes back in the seed
 * list is restored (retired_at cleared) and re-snapshotted like an update.
 *
 * Bumping a loop's `version` is the deliberate signal that propagates a
 * change: `LoopVersionPusher` (services/loop-version-pusher.ts) polls
 * hourly for installed_loops rows whose installedVersion has fallen behind
 * marketplaceLoops.version and re-provisions locked installs accordingly.
 *
 * Loop configs + snapshot data live in apps/dev/src/lib/marketplace-loops/.
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
			retiredAt: marketplaceLoops.retiredAt,
		})
		.from(marketplaceLoops)
	const existingBySlug = new Map(existingRows.map((r) => [r.slug, r]))

	const inserted: string[] = []
	const updated: string[] = []
	const unchanged: string[] = []
	const retired: string[] = []

	await db.transaction(async (tx) => {
		for (const config of MARKETPLACE_SEED_CONFIGS) {
			const existing = existingBySlug.get(config.loop.slug)
			// A retired row is never "unchanged": it falls through to the update path,
			// which clears retired_at and re-snapshots the items.
			if (existing && existing.version === config.loop.version && !existing.retiredAt) {
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
						retiredAt: null,
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

		const seededSlugs = new Set(MARKETPLACE_SEED_CONFIGS.map((config) => config.loop.slug))
		const toRetire = existingRows.filter((r) => !seededSlugs.has(r.slug) && !r.retiredAt)
		if (toRetire.length > 0) {
			await tx
				.update(marketplaceLoops)
				.set({ retiredAt: new Date(), updatedAt: new Date() })
				.where(
					inArray(
						marketplaceLoops.id,
						toRetire.map((r) => r.id),
					),
				)
			retired.push(...toRetire.map((r) => r.slug))
		}
	})

	return { inserted, updated, unchanged, retired }
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
 * - On an existing database, looks up the first human with a workspace they're
 *   a member of and mints them a fresh dev key (keys are stored hashed, so an
 *   existing one can't be read back), so the startup banner can still show a
 *   working `claude mcp add` command without the user hunting in the UI.
 *
 * Skipped in production or when MASKIN_AUTO_BOOTSTRAP=false.
 */
export async function maybeBootstrapDev(
	db: Database,
	agentStorage?: AgentStorageManager,
	sessionManager?: SessionManager,
): Promise<DevBootstrapResult | null> {
	if (process.env.NODE_ENV === 'production') return null
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return null

	const existing = await findExistingCredentials(db)
	if (existing) return existing

	const [actor] = await db
		.insert(actors)
		.values({
			type: 'human',
			name: 'You',
			email: 'dev@local',
		})
		.returning()

	if (!actor) throw new Error('dev bootstrap: failed to create actor')
	const { key } = await issueApiKey(db, { actorId: actor.id, kind: 'primary' })

	// Same provisioning path as POST /api/workspaces and signup: full default
	// agent roster, skills, triggers, default loops, pinned chat agent, and the
	// Chief of Staff welcome session.
	const workspace = await provisionWorkspace({
		db,
		agentStorage,
		sessionManager,
		name: 'My Workspace',
		ownerActorId: actor.id,
		settings: { enabled_modules: ['work', 'crm', 'knowledge'] },
	})

	if (!workspace) throw new Error('dev bootstrap: failed to create workspace')

	// TTV instrumentation: this is the first (and per findExistingCredentials
	// only) workspace the auto-bootstrap creates for a fresh install; agents
	// have just been seeded as workspace members and can run against it.
	// Fire-and-forget — never blocks or throws.
	emitWorkspaceFirstReady({ workspaceId: workspace.id, actorId: actor.id }).catch(() => {})

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
			actorId: actors.id,
			actorName: actors.name,
			actorEmail: actors.email,
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
		})
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(actors.type, 'human'))
		.limit(1)

	if (!row) return null
	return {
		apiKey: await issueLoginKey(db, row.actorId, 'login'),
		workspaceId: row.workspaceId,
		actorName: row.actorName ?? 'You',
		actorEmail: row.actorEmail ?? 'dev@local',
		workspaceName: row.workspaceName,
		created: false,
	}
}
