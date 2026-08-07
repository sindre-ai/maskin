import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers T3 of the Marketplace polish bet: the inline "N in the marketplace"
// count beside the Marketplace title. N is the loop count from the same
// hook that feeds the grid, so the value the user sees must equal the "All"
// filter count rendered from that same payload.

const COUNT = '[data-testid="marketplace-count"]'

test.describe('Marketplace loop count', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders next to the title and matches the "All" filter count at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const title = page.getByRole('heading', { name: 'Marketplace', level: 1 })
			await expect(title).toBeVisible({ timeout: 20000 })

			const count = page.locator(COUNT)
			await expect(count).toBeVisible({ timeout: 20000 })
			await expect(count).toHaveText(/^\d+ in the marketplace$/)

			const marketplaceSize = Number(((await count.textContent()) ?? '').match(/^(\d+)/)?.[1])
			expect(Number.isFinite(marketplaceSize) && marketplaceSize > 0).toBe(true)

			// Same-source check: the sidebar (≥md) and mobile chip strip both
			// render an "All N" from the same marketplace-loops payload that
			// feeds the header count, so the two must always match.
			const allTrigger = page.getByRole('button', { name: /^All\s+\d+$/ }).first()
			await expect(allTrigger).toBeVisible()
			const allLabel = (await allTrigger.textContent()) ?? ''
			const allCount = Number(allLabel.match(/(\d+)/)?.[1])
			expect(allCount).toBe(marketplaceSize)

			// Layout gate: the header wrapper must not push the page into
			// horizontal overflow at any ship-gate viewport.
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)
		})
	}
})
