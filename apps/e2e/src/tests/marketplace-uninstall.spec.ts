import { expect, test } from '../fixtures/auth.fixture'
import { E2E_CATALOG, reifyE2EMarketplaceCatalog } from '../fixtures/marketplace-e2e-catalog'

// Install → Manage → Uninstall confirm → card returns to Install state.
//
// Covers tech spec §9.3 "marketplace-uninstall.spec.ts" verbatim. Uses the
// dedicated `uninstall` fixture slug so this spec's install/uninstall churn
// doesn't collide with the golden-path spec running in parallel (Playwright
// workers=1 today, but the fixture separation is future-proofing).

const DB_URL_FOR_E2E =
	process.env.E2E_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL

test.describe('Marketplace uninstall flow', () => {
	test.beforeAll(async () => {
		if (!DB_URL_FOR_E2E) {
			throw new Error(
				'E2E marketplace specs need E2E_DATABASE_URL (or POSTGRES_URL) pointed at the local dev database so reifyE2EMarketplaceCatalog can seed the fixture rows before spec runs.',
			)
		}
		await reifyE2EMarketplaceCatalog(DB_URL_FOR_E2E)
	})

	test('installed loop can be uninstalled and the card returns to Install', async ({
		page,
		account,
	}) => {
		const loop = E2E_CATALOG.loops.uninstall
		await page.goto(`/${account.workspaceId}/marketplace`)

		// Install the fixture loop.
		const card = page
			.locator('article')
			.filter({ has: page.getByRole('heading', { name: loop.displayName }) })
			.first()
		await expect(card).toBeVisible({ timeout: 20000 })
		await card.getByRole('button', { name: /^install$/i }).click()

		const installModal = page.getByRole('dialog')
		await expect(installModal.getByText(/installed|success|done/i)).toBeVisible({
			timeout: 20000,
		})
		await installModal.getByRole('button', { name: /done|close/i }).click()

		// Manage → Uninstall. The Manage dropdown / detail-page overflow menu
		// carries a "Remove from workspace" item per the existing
		// marketplace-install-state.spec.ts conventions.
		await expect(card.getByText(/installed|manage/i)).toBeVisible({ timeout: 20000 })
		const manage = card.getByRole('button', { name: /manage/i }).first()
		if (await manage.count()) {
			await manage.click()
			await page.getByRole('menuitem', { name: /remove from workspace|uninstall/i }).click()
		} else {
			// Compact-card variant surfaces uninstall via the detail page
			// overflow menu.
			await card.getByRole('link', { name: /open|details/i }).first().click()
			await page.getByRole('button', { name: /loop actions|manage/i }).click()
			await page.getByRole('menuitem', { name: /remove from workspace|uninstall/i }).click()
		}

		// Confirmation dialog — two-tap confirm per tech spec §3.3.
		const confirmDialog = page.getByRole('dialog')
		await expect(confirmDialog).toBeVisible()
		await confirmDialog.getByRole('button', { name: /remove|uninstall/i }).click()

		// Back to marketplace, verify Install button returns.
		await page.goto(`/${account.workspaceId}/marketplace`)
		const revertedCard = page
			.locator('article')
			.filter({ has: page.getByRole('heading', { name: loop.displayName }) })
			.first()
		await expect(revertedCard.getByRole('button', { name: /^install$/i })).toBeVisible({
			timeout: 20000,
		})
		await expect(revertedCard.getByText(/^installed$/i)).toHaveCount(0)
	})
})
