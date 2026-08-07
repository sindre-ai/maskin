// One-shot publisher for the Deal & Relationship Loop marketplace bundle.
//
// Snapshots Deal Closer, Relationship Warmer, and SalesOps, plus every
// trigger they drive, from the checked-in data/growth-actors.json +
// data/growth-triggers.json (captured live from the Growth workspace) into a
// single `marketplace_loops` row at version 1.0.0 plus one
// `marketplace_loop_items` row per element. Triggers carry the source
// `target_actor_id` inside the snapshot — the install path rewrites that
// against the install's `source_item_id` map.
//
// Run once against the target DB:
//   pnpm --filter @maskin/dev exec tsx scripts/publish-growth-deal-relationship-loop.ts
//
// Idempotency: the `marketplace_loops.slug` unique constraint blocks a second
// run at the same slug; pass `--force` to delete and re-create the row plus
// its items. `--force` is refused if the loop already has installs.

import { createDb } from '@maskin/db'
import { installedLoops, marketplaceLoopItems, marketplaceLoops } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS,
	GROWTH_DEAL_RELATIONSHIP_LOOP,
	GROWTH_DEAL_RELATIONSHIP_SKILL_IDS,
	GROWTH_DEAL_RELATIONSHIP_SOURCE_WORKSPACE_ID,
	GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS,
	actorSnapshot,
	skillSnapshot,
	triggerSnapshot,
} from '../src/lib/marketplace-loops/growth-deal-relationship-loop'
import { getActorData, getSkillData, getTriggerData } from '../src/lib/marketplace-loops/loop-data'

const SOURCE_WORKSPACE_ID =
	process.env.GROWTH_DEAL_RELATIONSHIP_SOURCE_WORKSPACE_ID ??
	GROWTH_DEAL_RELATIONSHIP_SOURCE_WORKSPACE_ID
const FORCE = process.argv.includes('--force')

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(url)

	// Resolve actor/trigger content from the checked-in snapshot data (not the
	// local DB, which has none). These throw a clear error naming any missing id.
	const actorRows = GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS.map(getActorData)
	const triggerRows = GROWTH_DEAL_RELATIONSHIP_TRIGGER_IDS.map(getTriggerData)
	const skillRows = GROWTH_DEAL_RELATIONSHIP_SKILL_IDS.map(getSkillData)

	// Every published trigger must fire one of the published actors or the
	// install will resolve target_actor_id to a stale, unrelated UUID in the
	// installer workspace.
	const publishedActorIds = new Set<string>(GROWTH_DEAL_RELATIONSHIP_ACTOR_IDS)
	for (const t of triggerRows) {
		if (!publishedActorIds.has(t.targetActorId)) {
			throw new Error(
				`Trigger ${t.id} (${t.name}) targets actor ${t.targetActorId}, which is not in the published actor set.`,
			)
		}
	}

	// Guard against pulling an item from the wrong workspace. Only triggers and
	// skills carry a workspaceId — actors are global (workspace membership
	// lives in workspace_members, not on the actor row), so they pass through
	// by design.
	for (const row of [...actorRows, ...triggerRows, ...skillRows]) {
		const wsId = (row as { workspaceId?: string }).workspaceId
		if (wsId !== undefined && wsId !== SOURCE_WORKSPACE_ID) {
			throw new Error(`Item ${row.id} lives in workspace ${wsId}, expected ${SOURCE_WORKSPACE_ID}.`)
		}
	}

	const [existing] = await db
		.select()
		.from(marketplaceLoops)
		.where(eq(marketplaceLoops.slug, GROWTH_DEAL_RELATIONSHIP_LOOP.slug))
		.limit(1)

	if (existing && !FORCE) {
		console.error(
			`Loop ${GROWTH_DEAL_RELATIONSHIP_LOOP.slug} is already published as ${existing.id} at v${existing.version}. Pass --force to delete and re-create.`,
		)
		process.exit(1)
	}

	if (existing && FORCE) {
		const [install] = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.sourceLoopId, existing.id))
			.limit(1)
		if (install) {
			console.error(
				`Cannot --force re-publish ${GROWTH_DEAL_RELATIONSHIP_LOOP.slug}: it has at least one active install (installed_loops.source_loop_id = ${existing.id}). Deleting it would orphan those installs — publish a new version instead.`,
			)
			process.exit(1)
		}
	}

	const inserted = await db.transaction(async (tx) => {
		if (existing && FORCE) {
			await tx.delete(marketplaceLoops).where(eq(marketplaceLoops.id, existing.id))
		}

		const [loop] = await tx
			.insert(marketplaceLoops)
			.values({
				slug: GROWTH_DEAL_RELATIONSHIP_LOOP.slug,
				name: GROWTH_DEAL_RELATIONSHIP_LOOP.name,
				description: GROWTH_DEAL_RELATIONSHIP_LOOP.description,
				version: GROWTH_DEAL_RELATIONSHIP_LOOP.version,
				useCase: GROWTH_DEAL_RELATIONSHIP_LOOP.useCase,
			})
			.returning()

		if (!loop) throw new Error('marketplace_loops insert returned no row')

		const itemRows = [
			...actorRows.map((row) => ({
				loopId: loop.id,
				itemType: 'actor' as const,
				sourceItemId: row.id,
				itemSnapshot: actorSnapshot(row),
			})),
			...triggerRows.map((row) => ({
				loopId: loop.id,
				itemType: 'trigger' as const,
				sourceItemId: row.id,
				itemSnapshot: triggerSnapshot(row),
			})),
			...skillRows.map((row) => ({
				loopId: loop.id,
				itemType: 'skill' as const,
				sourceItemId: row.id,
				itemSnapshot: skillSnapshot(
					row,
					row.attachedActorIds.filter((id) => publishedActorIds.has(id)),
				),
			})),
		]

		await tx.insert(marketplaceLoopItems).values(itemRows)
		return { loop, itemCount: itemRows.length }
	})

	console.log(
		`Published ${GROWTH_DEAL_RELATIONSHIP_LOOP.slug} v${GROWTH_DEAL_RELATIONSHIP_LOOP.version} as ${inserted.loop.id} (${actorRows.length} actors + ${triggerRows.length} triggers + ${skillRows.length} skills = ${inserted.itemCount} items).`,
	)
	process.exit(0)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exit(1)
})
