import { catalogPackageItems, catalogPackages } from '@maskin/db/schema'
import { upsertCatalogPackage } from '@maskin/db/seed-helpers'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { db, sql } from './global-setup'

// Regression for the catalog-seed re-provisioning gap: `packages/db/src/seed.ts`
// previously used plain `db.insert(catalogPackages)`, so a `DEV_PACKAGE_VERSION`
// bump on a pre-existing prod DB never landed — `catalog_packages.version` stayed
// frozen and `PackageVersionPusher.pushLockedInstall` (which keys on
// `installedPackages.installedVersion != catalogPackages.version`) had nothing to
// push. The seed now routes through `upsertCatalogPackage` (in `seed-helpers.ts`)
// which upserts on `slug` and clears the package's items so the caller's
// subsequent items insert lands a clean set.
describe('upsertCatalogPackage', () => {
	const slug = 'integration-test-upsert-pkg'

	afterEach(async () => {
		await sql`DELETE FROM catalog_packages WHERE slug = ${slug}`
	})

	it('re-inserting the same slug with a bumped version updates the existing row', async () => {
		const [initial] = await upsertCatalogPackage(db, {
			slug,
			name: 'Initial Name',
			description: 'Initial description',
			version: '1.0.0',
			useCase: 'Development',
		})

		expect(initial?.version).toBe('1.0.0')
		const initialId = initial?.id
		const initialCreatedAt = initial?.createdAt
		const initialUpdatedAt = initial?.updatedAt

		// Force the clock forward enough that updatedAt is observably newer.
		await new Promise((resolve) => setTimeout(resolve, 10))

		const [updated] = await upsertCatalogPackage(db, {
			slug,
			name: 'Renamed Pkg',
			description: 'Updated description',
			version: '1.1.0',
			useCase: 'Discovery',
		})

		expect(updated?.id, 'row id must be stable across re-seed').toBe(initialId)
		expect(updated?.version, 'version must advance to the new constant').toBe('1.1.0')
		expect(updated?.name).toBe('Renamed Pkg')
		expect(updated?.description).toBe('Updated description')
		expect(updated?.useCase).toBe('Discovery')
		expect(
			updated && initialCreatedAt && updated.createdAt.getTime() === initialCreatedAt.getTime(),
			'created_at must not move on upsert',
		).toBe(true)
		expect(
			updated && initialUpdatedAt && updated.updatedAt.getTime() > initialUpdatedAt.getTime(),
			'updated_at must advance on upsert',
		).toBe(true)

		// Confirm there is exactly one row for the slug — no accidental duplicate inserts.
		const rows = await db.select().from(catalogPackages).where(eq(catalogPackages.slug, slug))
		expect(rows).toHaveLength(1)
	})

	it('clears existing catalog_package_items for the package on re-upsert', async () => {
		// `catalog_package_items` has no unique constraint on (package_id,
		// source_item_id), so without the helper's delete a re-seed would
		// duplicate every items row. This test pins that guarantee.
		const [initial] = await upsertCatalogPackage(db, {
			slug,
			name: 'Pkg',
			description: 'Desc',
			version: '1.0.0',
			useCase: 'Development',
		})
		const pkgId = initial?.id
		expect(pkgId).toBeTruthy()
		if (!pkgId) return

		await db.insert(catalogPackageItems).values([
			{
				packageId: pkgId,
				itemType: 'actor',
				sourceItemId: '11111111-1111-1111-1111-111111111111',
				itemSnapshot: { name: 'first-actor' },
			},
			{
				packageId: pkgId,
				itemType: 'trigger',
				sourceItemId: '22222222-2222-2222-2222-222222222222',
				itemSnapshot: { name: 'first-trigger' },
			},
		])

		const before = await db
			.select()
			.from(catalogPackageItems)
			.where(eq(catalogPackageItems.packageId, pkgId))
		expect(before).toHaveLength(2)

		// Re-upsert (same slug). Helper must clear the package's items so the
		// caller's subsequent insert lands a clean set, not duplicates.
		await upsertCatalogPackage(db, {
			slug,
			name: 'Pkg',
			description: 'Desc',
			version: '1.1.0',
			useCase: 'Development',
		})

		const after = await db
			.select()
			.from(catalogPackageItems)
			.where(eq(catalogPackageItems.packageId, pkgId))
		expect(
			after,
			'package items must be cleared on upsert so the caller can reinsert',
		).toHaveLength(0)
	})
})
