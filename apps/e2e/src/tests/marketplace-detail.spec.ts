import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers the marketplace subpages bet: clicking a catalog card opens a
// read-only detail page (loop bundle, or a single item within a bundle)
// instead of doing nothing. The dev bootstrap seeds bundle loops (actor +
// trigger + skill items), so the marketplace grid has both loop cards and
// individual item cards without extra setup.

test.describe('Marketplace detail pages', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`opens a loop's detail page and returns via back @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const loopsSection = page.getByRole('region', { name: 'Loops' })
			await expect(loopsSection).toBeVisible({ timeout: 20000 })

			const firstCard = loopsSection.locator('article').first()
			const loopName = (await firstCard.locator('h3').first().textContent())?.trim()
			expect(loopName).toBeTruthy()

			await firstCard.locator('h3').first().click()

			await expect(page).toHaveURL(/\/marketplace\/[^/]+\/?$/)
			await expect(page.getByRole('heading', { name: loopName ?? '', level: 1 })).toBeVisible({
				timeout: 20000,
			})
			await expect(page.getByText('What it brings')).toBeVisible()

			// Layout gate — the detail page must not overflow the viewport.
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)

			await page.getByRole('button', { name: 'Go back' }).click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/marketplace$`))
			await expect(loopsSection).toBeVisible()
		})
	}

	test('opens an item detail page from the Agents section and links back to its loop', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		const agentsSection = page.getByRole('region', { name: 'Agents' })
		await expect(agentsSection).toBeVisible({ timeout: 20000 })

		const firstItemCard = agentsSection.locator('article').first()
		const itemName = (await firstItemCard.locator('h3').first().textContent())?.trim()
		expect(itemName).toBeTruthy()

		await firstItemCard.locator('h3').first().click()

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/[^/]+$/)
		await expect(page.getByRole('heading', { name: itemName ?? '', level: 1 })).toBeVisible({
			timeout: 20000,
		})
		await expect(page.getByText(/^AGENT$/i)).toBeVisible()

		const partOfLink = page.getByRole('link', { name: /^Part of / })
		await expect(partOfLink).toBeVisible()
		await partOfLink.click()

		await expect(page).toHaveURL(/\/marketplace\/[^/]+\/?$/)
		await expect(page.getByText('What it brings')).toBeVisible({ timeout: 20000 })
	})
})
