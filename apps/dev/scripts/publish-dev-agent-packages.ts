// One-shot publisher for the 17 single-agent Development-workspace catalog
// packages (see ./dev-agent-packages.ts for the full list).
//
// Snapshots each package's actor + wiring triggers from the checked-in
// data/dev-actors.json + data/dev-triggers.json (captured live from the
// Development workspace, since the local dev Postgres is empty) into its own
// `catalog_packages` row at version 1.0.0 plus one `catalog_package_items` row
// per element. Triggers carry the source `target_actor_id` inside the snapshot
// — the install path rewrites that against the install's `source_item_id` map.
//
// Every package is validated and published independently inside its own
// transaction, so one bad/missing package doesn't block the rest — failures
// are collected and reported at the end with a non-zero exit code.
//
// Run once against the local dev DB:
//   pnpm --filter @maskin/dev exec tsx scripts/publish-dev-agent-packages.ts
//
// Idempotency: the `catalog_packages.slug` unique constraint blocks a second
// run at the same slug; pass `--force` to delete and re-create the row plus
// its items for any package that already exists. `--force` is refused per
// package if that package already has installs.

import { createDb } from '@maskin/db'
import { catalogPackageItems, catalogPackages, installedPackages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	DEV_AGENT_PACKAGES,
	DEV_AGENT_PACKAGES_SOURCE_WORKSPACE_ID,
	type DevAgentPackageConfig,
	actorSnapshot,
	skillSnapshot,
	triggerSnapshot,
} from './dev-agent-packages'
import { getActorData, getSkillData, getTriggerData } from './package-data'

const SOURCE_WORKSPACE_ID =
	process.env.DEV_AGENT_PACKAGES_SOURCE_WORKSPACE_ID ?? DEV_AGENT_PACKAGES_SOURCE_WORKSPACE_ID
const FORCE = process.argv.includes('--force')

async function publishOne(
	db: ReturnType<typeof createDb>,
	config: DevAgentPackageConfig,
): Promise<void> {
	const { slug } = config.package

	// Resolve actor/trigger content from the checked-in snapshot data (not the
	// local DB, which has none). getActorData/getTriggerData throw a clear error
	// naming any id that isn't present in the JSON.
	const actorRows = config.actorIds.map(getActorData)
	const triggerRows = config.triggerIds.map(getTriggerData)
	const skillRows = config.skillIds.map(getSkillData)

	// Every published trigger must fire one of the published actors or the
	// install will resolve target_actor_id to a stale, unrelated UUID in the
	// installer workspace.
	const publishedActorIds = new Set<string>(config.actorIds)
	for (const t of triggerRows) {
		if (!publishedActorIds.has(t.targetActorId)) {
			throw new Error(
				`${slug}: trigger ${t.id} (${t.name}) targets actor ${t.targetActorId}, which is not in the published actor set.`,
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
			throw new Error(
				`${slug}: item ${row.id} lives in workspace ${wsId}, expected ${SOURCE_WORKSPACE_ID}.`,
			)
		}
	}

	const [existing] = await db
		.select()
		.from(catalogPackages)
		.where(eq(catalogPackages.slug, slug))
		.limit(1)

	if (existing && !FORCE) {
		throw new Error(
			`${slug} is already published as ${existing.id} at v${existing.version}. Pass --force to delete and re-create.`,
		)
	}

	if (existing && FORCE) {
		const [install] = await db
			.select({ id: installedPackages.id })
			.from(installedPackages)
			.where(eq(installedPackages.sourcePackageId, existing.id))
			.limit(1)
		if (install) {
			throw new Error(
				`Cannot --force re-publish ${slug}: it has at least one active install (installed_packages.source_package_id = ${existing.id}). Deleting it would orphan those installs — publish a new version instead.`,
			)
		}
	}

	const inserted = await db.transaction(async (tx) => {
		if (existing && FORCE) {
			await tx.delete(catalogPackages).where(eq(catalogPackages.id, existing.id))
		}

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

		if (!pkg) throw new Error(`${slug}: catalog_packages insert returned no row`)

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
		`Published ${slug} v${config.package.version} as ${inserted.pkg.id} (${actorRows.length} actors + ${triggerRows.length} triggers + ${skillRows.length} skills = ${inserted.itemCount} items).`,
	)
}

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(url)

	const failures: string[] = []
	for (const config of DEV_AGENT_PACKAGES) {
		try {
			await publishOne(db, config)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			console.error(message)
			failures.push(config.package.slug)
		}
	}

	if (failures.length > 0) {
		console.error(
			`\n${failures.length}/${DEV_AGENT_PACKAGES.length} packages failed: ${failures.join(', ')}`,
		)
		process.exit(1)
	}

	console.log(`\nPublished all ${DEV_AGENT_PACKAGES.length} packages.`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exit(1)
})
