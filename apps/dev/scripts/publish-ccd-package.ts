// One-shot publisher for the Customer Continuous Discovery catalog package.
//
// Snapshots the four canonical CCD-loop agents and their nine bound triggers
// from a source workspace (the Maskin development workspace by default) into a
// single `catalog_packages` row at version 1.0.0 plus one
// `catalog_package_items` row per element. Triggers carry the publisher's
// live `target_actor_id` inside the snapshot — the install path (T3) rewrites
// that against the install's `source_item_id` map, which we set to the live
// publisher id here so the lookup is direct.
//
// Run once against the dev DB:
//   POSTGRES_URL=... pnpm --filter @maskin/dev exec tsx scripts/publish-ccd-package.ts
//
// Idempotency: the `catalog_packages.slug` unique constraint blocks a second
// run at the same slug; pass `--force` to delete and re-create the row plus
// its items.

import { createDb } from '@maskin/db'
import { actors, catalogPackageItems, catalogPackages, triggers } from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import {
	CCD_ACTOR_IDS,
	CCD_PACKAGE,
	CCD_SOURCE_WORKSPACE_ID,
	CCD_TRIGGER_IDS,
	actorSnapshot,
	triggerSnapshot,
} from './ccd-package'

const SOURCE_WORKSPACE_ID = process.env.CCD_SOURCE_WORKSPACE_ID ?? CCD_SOURCE_WORKSPACE_ID
const FORCE = process.argv.includes('--force')

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(url)

	const actorRows = await db
		.select()
		.from(actors)
		.where(inArray(actors.id, [...CCD_ACTOR_IDS]))

	const triggerRows = await db
		.select()
		.from(triggers)
		.where(inArray(triggers.id, [...CCD_TRIGGER_IDS]))

	if (actorRows.length !== CCD_ACTOR_IDS.length) {
		const found = new Set(actorRows.map((a) => a.id))
		const missing = CCD_ACTOR_IDS.filter((id) => !found.has(id))
		throw new Error(`CCD actors missing from source workspace: ${missing.join(', ')}`)
	}
	if (triggerRows.length !== CCD_TRIGGER_IDS.length) {
		const found = new Set(triggerRows.map((t) => t.id))
		const missing = CCD_TRIGGER_IDS.filter((id) => !found.has(id))
		throw new Error(`CCD triggers missing from source workspace: ${missing.join(', ')}`)
	}

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

	for (const row of [...actorRows, ...triggerRows]) {
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
		]

		await tx.insert(catalogPackageItems).values(itemRows)
		return { pkg, itemCount: itemRows.length }
	})

	console.log(
		`Published ${CCD_PACKAGE.slug} v${CCD_PACKAGE.version} as ${inserted.pkg.id} (${actorRows.length} actors + ${triggerRows.length} triggers = ${inserted.itemCount} items).`,
	)
	process.exit(0)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exit(1)
})
