// One-shot publisher for the Customer Continuous Discovery catalog bundle.
//
// Snapshots the three CCD-loop agents (Customer Feedback Agent, Insights Triage
// Agent, Product Ideator) and every trigger they drive from the checked-in
// data/dev-actors.json + data/dev-triggers.json (captured live, since the local
// dev Postgres is empty) into a single `catalog_packages` row at version 1.0.0
// plus one `catalog_package_items` row per element. Triggers carry the source
// `target_actor_id` inside the snapshot — the install path rewrites that
// against the install's `source_item_id` map.
//
// Run once against the local dev DB:
//   pnpm --filter @maskin/dev exec tsx scripts/publish-ccd-package.ts
//
// Idempotency: the `catalog_packages.slug` unique constraint blocks a second
// run at the same slug; pass `--force` to delete and re-create the row plus
// its items. `--force` is refused if the package already has installs.

import { createDb } from '@maskin/db'
import { catalogPackageItems, catalogPackages, installedPackages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	CCD_ACTOR_IDS,
	CCD_PACKAGE,
	CCD_SKILL_IDS,
	CCD_SOURCE_WORKSPACE_ID,
	CCD_TRIGGER_IDS,
	actorSnapshot,
	skillSnapshot,
	triggerSnapshot,
} from '../src/lib/catalog-packages/ccd-package'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../src/lib/catalog-packages/package-data'

const SOURCE_WORKSPACE_ID = process.env.CCD_SOURCE_WORKSPACE_ID ?? CCD_SOURCE_WORKSPACE_ID
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
	const actorRows = CCD_ACTOR_IDS.map(getActorData)
	const triggerRows = CCD_TRIGGER_IDS.map(getTriggerData)
	const skillRows = CCD_SKILL_IDS.map(getSkillData)

	// Every published trigger must fire one of the published actors or the
	// install will resolve target_actor_id to a stale, unrelated UUID in the
	// installer workspace.
	const publishedActorIds = new Set<string>(CCD_ACTOR_IDS)
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

	// Idempotency. Without --force we refuse to overwrite an existing publish
	// of the same slug — re-publishing a version silently is exactly what
	// breaks reproducibility for already-installed workspaces.
	const [existing] = await db
		.select()
		.from(catalogPackages)
		.where(eq(catalogPackages.slug, CCD_PACKAGE.slug))
		.limit(1)

	if (existing && !FORCE) {
		console.error(
			`Package ${CCD_PACKAGE.slug} is already published as ${existing.id} at v${existing.version}. Pass --force to delete and re-create.`,
		)
		process.exit(1)
	}

	// --force deletes the existing catalog row, cascading to its items. But
	// installed_packages.source_package_id is ON DELETE NO ACTION, so the delete
	// would fail with a raw Postgres FK violation if any workspace has already
	// installed this package. Detect that up front and refuse with a clear
	// message — blowing away a package out from under live installs orphans their
	// lineage; the right move is to publish a new version, not re-cut this one.
	if (existing && FORCE) {
		const [install] = await db
			.select({ id: installedPackages.id })
			.from(installedPackages)
			.where(eq(installedPackages.sourcePackageId, existing.id))
			.limit(1)
		if (install) {
			console.error(
				`Cannot --force re-publish ${CCD_PACKAGE.slug}: it has at least one active install (installed_packages.source_package_id = ${existing.id}). Deleting it would orphan those installs — publish a new version instead.`,
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
				slug: CCD_PACKAGE.slug,
				name: CCD_PACKAGE.name,
				description: CCD_PACKAGE.description,
				version: CCD_PACKAGE.version,
				useCase: CCD_PACKAGE.useCase,
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
		`Published ${CCD_PACKAGE.slug} v${CCD_PACKAGE.version} as ${inserted.pkg.id} (${actorRows.length} actors + ${triggerRows.length} triggers + ${skillRows.length} skills = ${inserted.itemCount} items).`,
	)
	process.exit(0)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exit(1)
})
