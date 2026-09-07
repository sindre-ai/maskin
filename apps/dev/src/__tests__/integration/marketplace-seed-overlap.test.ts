import { describe, it } from 'vitest'

/**
 * Seed-overlap tests — deferred to Marketplace PR #1.
 *
 * The seed-reify migration (§3.4, §7) that provisions marketplace_installations
 * rows with `source='seed'` for freshly-bootstrapped workspaces lives in PR #1
 * (Schema + migrations). Until that migration and the packages/shared/src/
 * templates/marketplace-catalog.ts manifest land, there are no seeded catalog
 * rows to overlap against, so the assertions here have nothing to bind to.
 *
 * The suite is kept as a placeholder so the file name required by the PR #2
 * acceptance-criteria list is present and the eventual PR #1 driver has a
 * home to drop the real assertions into. See PR body §What this PR
 * deliberately does NOT touch.
 */

describe.skip('marketplace-seed-overlap — deferred to PR #1', () => {
	it('placeholder — bind assertions once PR #1 ships the seed reify migration', () => {
		// Real assertions land alongside packages/shared/src/templates/
		// marketplace-catalog.ts + NNNN_seed_marketplace_catalog.sql.
	})
})
