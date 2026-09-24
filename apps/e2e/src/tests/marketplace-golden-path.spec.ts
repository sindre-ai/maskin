import { expect, test } from '../fixtures/auth.fixture'
import { E2E_CATALOG, reifyE2EMarketplaceCatalog } from '../fixtures/marketplace-e2e-catalog'

// Golden-path: fresh workspace opens /marketplace, sees the Recommended band
// with a rendered WHY line, clicks Install on the goldenPath fixture loop
// (no requires), watches the card flip to the Installed / Manage state,
// opens the sidebar, verifies the loop appears in the loops list.
//
// Covers tech spec §9.3 "marketplace-golden-path.spec.ts" verbatim.

const DB_URL_FOR_E2E =
	process.env.E2E_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL

test.describe('Marketplace golden path', () => {
	test.beforeAll(async () => {
		if (!DB_URL_FOR_E2E) {
			throw new Error(
				'E2E marketplace specs need E2E_DATABASE_URL (or POSTGRES_URL) pointed at the local dev database so reifyE2EMarketplaceCatalog can seed the fixture rows before spec runs.',
			)
		}
		await reifyE2EMarketplaceCatalog(DB_URL_FOR_E2E)
	})

	test('user installs a no-requires loop from the Recommended band and it lands in the sidebar', async ({
		page,
		account,
	}) => {
		const loop = E2E_CATALOG.loops.goldenPath
		await page.goto(`/${account.workspaceId}/marketplace`)

		// Marketplace page landed — the Recommended band is the first thing
		// on-screen per the design spec (band ordering: Recommended, Popular
		// loops, Top agents, Popular skills, Most-installed tools).
		const recommended = page.getByRole('region', { name: /recommended for you/i })
		await expect(recommended).toBeVisible({ timeout: 20000 })

		// Locate the goldenPath fixture card by its display name.
		const card = recommended.locator('article').filter({
			has: page.getByRole('heading', { name: loop.displayName }),
		})
		await expect(card).toBeVisible()

		// WHY line rendered — a load-bearing indigo pill inside the recommended
		// card; the fixture recommendation rule fires for every workspace so
		// this assertion is deterministic.
		await expect(card.getByText(loop.whyLine)).toBeVisible()

		// Card is not installed yet on a fresh workspace.
		const installButton = card.getByRole('button', { name: /^install$/i })
		await expect(installButton).toBeVisible()

		// Install: click → modal "installing" → "success" → dismiss → card
		// flips to the Manage state. The modal-dismiss timing is set by the
		// design spec's 200ms transition; give a generous timeout.
		await installButton.click()

		// The install modal opens with role="dialog"; on success the primary
		// button flips to "Done" per the design spec Copy section.
		const modal = page.getByRole('dialog')
		await expect(modal).toBeVisible({ timeout: 20000 })
		await expect(modal.getByText(/installed|success|done/i)).toBeVisible({ timeout: 20000 })
		await modal.getByRole('button', { name: /done|close/i }).click()

		// Recommended-band cards disappear from Recommended when installed but
		// stay in Popular loops. Assert the goldenPath row now sits under
		// Popular loops with the Manage state.
		const popular = page.getByRole('region', { name: /popular loops/i })
		const installedCard = popular.locator('article').filter({
			has: page.getByRole('heading', { name: loop.displayName }),
		})
		await expect(installedCard).toBeVisible({ timeout: 20000 })
		await expect(installedCard.getByText(/installed|manage/i)).toBeVisible()

		// The recommended-band no longer surfaces this loop.
		await expect(
			recommended.locator('article').filter({
				has: page.getByRole('heading', { name: loop.displayName }),
			}),
		).toHaveCount(0)

		// Sidebar verification: the loop appears in the workspace's loops list
		// via the PG NOTIFY → SSE bridge (tech spec §8.1). Wait for it to
		// surface rather than reloading — we want the realtime path exercised.
		const sidebar = page.getByRole('navigation', { name: /sidebar|workspace/i }).first()
		await expect(sidebar.getByText(loop.displayName)).toBeVisible({ timeout: 20000 })
	})
})
