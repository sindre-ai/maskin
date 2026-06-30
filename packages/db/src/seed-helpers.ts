import { eq } from 'drizzle-orm'
import type { Database } from './connection'
import { catalogPackageItems, catalogPackages } from './schema'

// Upsert keyed on `slug` so re-running the seed against a pre-existing DB
// advances `version` (and refreshes the other publish-time fields) instead of
// no-op'ing. PackageVersionPusher reads `catalog_packages.version` to decide
// which installs to re-provision, so a stale row blocks every workspace from
// seeing a new package release.
//
// `catalog_package_items` has no unique constraint on (package_id,
// source_item_id), so re-inserting items after an upsert would duplicate every
// row. We clear the package's existing items here so the subsequent
// `db.insert(catalogPackageItems).values([...])` block in the caller lands
// exactly the set declared in seed.ts — duplicates removed, dropped items
// pruned, new items added.
//
// Lives in its own module (not seed.ts) so the integration test can exercise
// the helper directly without re-running the CLI seed's top-level statements.
export async function upsertCatalogPackage(
	db: Database,
	values: {
		slug: string
		name: string
		description: string
		version: string
		useCase: string
	},
) {
	const rows = await db
		.insert(catalogPackages)
		.values(values)
		.onConflictDoUpdate({
			target: catalogPackages.slug,
			set: {
				name: values.name,
				description: values.description,
				version: values.version,
				useCase: values.useCase,
				updatedAt: new Date(),
			},
		})
		.returning()
	const pkg = rows[0]
	if (pkg) {
		await db.delete(catalogPackageItems).where(eq(catalogPackageItems.packageId, pkg.id))
	}
	return rows
}
