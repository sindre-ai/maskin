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

			// Header identity renders twice (desktop + mobile copies toggled via
			// CSS, same pattern as ForYouHeaderIdentity — see
			// foryou-prototype-responsive.spec.ts). data-testid queries see both
			// regardless of viewport, so filter to the one actually on-screen —
			// `.first()` alone isn't enough since the desktop copy comes first in
			// DOM order but is CSS-hidden below the md breakpoint.
			const identity = page.locator(`[data-testid="marketplace-header-identity"]:visible`).first()
			await expect(identity).toBeVisible({ timeout: 20000 })

			const count = page.locator(`${COUNT}:visible`).first()
			await expect(count).toBeVisible({ timeout: 20000 })
			await expect(count).toHaveText(/^\d+ in the marketplace$/)

			const allTrigger = page.getByRole('button', { name: /^All\s+\d+$/ }).first()
			await expect(allTrigger).toBeVisible()

			// Same-source check: the Type chip row's "All N" renders from the same
			// `countForFilter('all', ...)` call as the header count, in the same
			// render — but only once every bundle loop's item-detail query (fetched
			// separately per bundle) has resolved. Before that, the header count
			// reflects the loop-level fallback while later renders reflect the
			// fuller item-level total, so two separate reads a poll-cycle apart can
			// legitimately observe different moments in that ramp-up. Read both
			// from a single synchronous DOM snapshot (not two Playwright round
			// trips) to compare like-for-like.
			const { marketplaceSize, allCount } = await page.evaluate(() => {
				const isVisible = (el: Element | null) => {
					if (!el) return false
					const style = window.getComputedStyle(el)
					return style.display !== 'none' && style.visibility !== 'hidden'
				}
				const countEl = Array.from(
					document.querySelectorAll('[data-testid="marketplace-count"]'),
				).find(isVisible)
				const allButton = Array.from(document.querySelectorAll('button')).find(
					(b) => isVisible(b) && /^All\s+\d+$/.test(b.textContent?.trim() ?? ''),
				)
				return {
					marketplaceSize: Number((countEl?.textContent ?? '').match(/^(\d+)/)?.[1]),
					allCount: Number((allButton?.textContent ?? '').match(/(\d+)/)?.[1]),
				}
			})
			expect(Number.isFinite(marketplaceSize) && marketplaceSize > 0).toBe(true)
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
