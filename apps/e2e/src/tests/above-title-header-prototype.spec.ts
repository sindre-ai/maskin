import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 fit test — verifies the prototype scratch route renders TypeBadge +
// StatusSelect + IndicatorBadgeChip + OwnerSelect above the sample <h1> at
// 375 / 768 / 1024. Also emits a screenshot per breakpoint so the parent-bet
// fit-outcome comment has attachable evidence. Route is public (outside the
// `_authed` guard) so no seeded actor is needed.

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`above-title header prototype renders at ${vp.label}`, async ({ page }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.goto('/prototypes/above-title-header')

		const row = page.getByTestId('above-title-header')
		const title = page.getByTestId('prototype-title')

		await expect(row).toBeVisible()
		await expect(title).toBeVisible()

		// Fold check — the h1 must still be inside the viewport at 812 tall at
		// 375, which is the exit-criterion width. If this fails at 375 the bet
		// stops per parent-bet exit criterion.
		const titleBox = await title.boundingBox()
		expect(titleBox).not.toBeNull()
		if (titleBox) {
			expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
		}

		await page.screenshot({
			path: `test-results/above-title-header-${vp.width}.png`,
			fullPage: false,
		})
	})
}
