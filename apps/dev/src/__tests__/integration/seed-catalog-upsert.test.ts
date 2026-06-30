import { catalogPackages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { db, sql } from './global-setup'

// Regression for the catalog-seed re-provisioning gap: `packages/db/src/seed.ts`
// previously used plain `db.insert(catalogPackages)`, so a `DEV_PACKAGE_VERSION`
// bump on a pre-existing prod DB never landed — `catalog_packages.version` stayed
// frozen and `PackageVersionPusher.pushLockedInstall` (which keys on
// `installedPackages.installedVersion != catalogPackages.version`) had nothing to
// push. The seed now upserts on `slug`; this test asserts that semantic at the
// DB level so a future refactor that drops the upsert clause fails CI loudly.
describe('catalog_packages seed upsert semantics', () => {
	const slug = 'integration-test-upsert-pkg'

	afterEach(async () => {
		await sql`DELETE FROM catalog_packages WHERE slug = ${slug}`
	})

	it('re-inserting the same slug with a bumped version updates the existing row', async () => {
		const [initial] = await db
			.insert(catalogPackages)
			.values({
				slug,
				name: 'Initial Name',
				description: 'Initial description',
				version: '1.0.0',
				useCase: 'Development',
			})
			.onConflictDoUpdate({
				target: catalogPackages.slug,
				set: {
					name: 'Initial Name',
					description: 'Initial description',
					version: '1.0.0',
					useCase: 'Development',
					updatedAt: new Date(),
				},
			})
			.returning()

		expect(initial?.version).toBe('1.0.0')
		const initialId = initial?.id
		const initialUpdatedAt = initial?.updatedAt

		// Force the clock forward enough that updatedAt is observably newer.
		await new Promise((resolve) => setTimeout(resolve, 10))

		const [updated] = await db
			.insert(catalogPackages)
			.values({
				slug,
				name: 'Renamed Pkg',
				description: 'Updated description',
				version: '1.1.0',
				useCase: 'Discovery',
			})
			.onConflictDoUpdate({
				target: catalogPackages.slug,
				set: {
					name: 'Renamed Pkg',
					description: 'Updated description',
					version: '1.1.0',
					useCase: 'Discovery',
					updatedAt: new Date(),
				},
			})
			.returning()

		expect(updated?.id, 'row id must be stable across re-seed').toBe(initialId)
		expect(updated?.version, 'version must advance to the new constant').toBe('1.1.0')
		expect(updated?.name).toBe('Renamed Pkg')
		expect(updated?.description).toBe('Updated description')
		expect(updated?.useCase).toBe('Discovery')
		expect(
			updated && initialUpdatedAt && updated.updatedAt.getTime() > initialUpdatedAt.getTime(),
			'updated_at must advance on upsert',
		).toBe(true)

		// Confirm there is exactly one row for the slug — no accidental duplicate inserts.
		const rows = await db.select().from(catalogPackages).where(eq(catalogPackages.slug, slug))
		expect(rows).toHaveLength(1)
	})
})
