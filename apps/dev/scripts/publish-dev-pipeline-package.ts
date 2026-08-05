// One-shot publisher for the Build & Ship Loop catalog bundle.
//
// Snapshots Planner, Developer, Architect, Designer, Code Reviewer, and
// Workspace Driver, plus every trigger they drive, from the checked-in
// data/dev-actors.json + data/dev-triggers.json (captured live, since the
// local dev Postgres is empty) into a single `catalog_packages` row at
// version 1.0.0 plus one `catalog_package_items` row per element. Triggers
// carry the source `target_actor_id` inside the snapshot — the install path
// rewrites that against the install's `source_item_id` map.
//
// Run once against the local dev DB:
//   pnpm --filter @maskin/dev exec tsx scripts/publish-dev-pipeline-package.ts
//
// Idempotency: the `catalog_packages.slug` unique constraint blocks a second
// run at the same slug; pass `--force` to delete and re-create the row plus
// its items. `--force` is refused if the package already has installs.

import { createDb } from '@maskin/db'
import { catalogPackageItems, catalogPackages, installedPackages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	DEV_PIPELINE_ACTOR_IDS,
	DEV_PIPELINE_PACKAGE,
	DEV_PIPELINE_SKILL_IDS,
	DEV_PIPELINE_SOURCE_WORKSPACE_ID,
	DEV_PIPELINE_TRIGGER_IDS,
	actorSnapshot,
	skillSnapshot,
	triggerSnapshot,
} from '../src/lib/catalog-packages/dev-pipeline-package'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../src/lib/catalog-packages/package-data'

const SOURCE_WORKSPACE_ID =
	process.env.DEV_PIPELINE_SOURCE_WORKSPACE_ID ?? DEV_PIPELINE_SOURCE_WORKSPACE_ID
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
	const actorRows = DEV_PIPELINE_ACTOR_IDS.map(getActorData)
	const triggerRows = DEV_PIPELINE_TRIGGER_IDS.map(getTriggerData)
	const skillRows = DEV_PIPELINE_SKILL_IDS.map(getSkillData)

	// Every published trigger must fire one of the published actors or the
	// install will resolve target_actor_id to a stale, unrelated UUID in the
	// installer workspace.
	const publishedActorIds = new Set<string>(DEV_PIPELINE_ACTOR_IDS)
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
		.from(catalogPackages)
		.where(eq(catalogPackages.slug, DEV_PIPELINE_PACKAGE.slug))
		.limit(1)

	if (existing && !FORCE) {
		console.error(
			`Package ${DEV_PIPELINE_PACKAGE.slug} is already published as ${existing.id} at v${existing.version}. Pass --force to delete and re-create.`,
		)
		process.exit(1)
	}

	if (existing && FORCE) {
		const [install] = await db
			.select({ id: installedPackages.id })
			.from(installedPackages)
			.where(eq(installedPackages.sourcePackageId, existing.id))
			.limit(1)
		if (install) {
			console.error(
				`Cannot --force re-publish ${DEV_PIPELINE_PACKAGE.slug}: it has at least one active install (installed_packages.source_package_id = ${existing.id}). Deleting it would orphan those installs — publish a new version instead.`,
			)
			process.exit(1)
		}
	}

	const inserted = await db.transaction(async (tx) => {
		if (existing && FORCE) {
			await tx.delete(catalogPackages).where(eq(catalogPackages.id, existing.id))
		}

		const [pkg] = await tx
			.insert(catalogPackages)
			.values({
				slug: DEV_PIPELINE_PACKAGE.slug,
				name: DEV_PIPELINE_PACKAGE.name,
				description: DEV_PIPELINE_PACKAGE.description,
				version: DEV_PIPELINE_PACKAGE.version,
				useCase: DEV_PIPELINE_PACKAGE.useCase,
			})
			.returning()

		if (!pkg) throw new Error('catalog_packages insert returned no row')

		const itemRows = [
			...actorRows.map((row) => ({
				packageId: pkg.id,
				itemType: 'actor' as const,
				sourceItemId: row.id,
				itemSnapshot: actorSnapshot(row),
			})),
			...triggerRows.map((row) => ({
				packageId: pkg.id,
				itemType: 'trigger' as const,
				sourceItemId: row.id,
				itemSnapshot: triggerSnapshot(row),
			})),
			...skillRows.map((row) => ({
				packageId: pkg.id,
				itemType: 'skill' as const,
				sourceItemId: row.id,
				itemSnapshot: skillSnapshot(
					row,
					row.attachedActorIds.filter((id) => publishedActorIds.has(id)),
				),
			})),
		]

		await tx.insert(catalogPackageItems).values(itemRows)
		return { pkg, itemCount: itemRows.length }
	})

	console.log(
		`Published ${DEV_PIPELINE_PACKAGE.slug} v${DEV_PIPELINE_PACKAGE.version} as ${inserted.pkg.id} (${actorRows.length} actors + ${triggerRows.length} triggers + ${skillRows.length} skills = ${inserted.itemCount} items).`,
	)
	process.exit(0)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exit(1)
})
