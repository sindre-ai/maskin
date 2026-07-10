import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// F7: on coarse (touch) pointers the quick-start chips inside the SparseComposer
// (For You empty state, `items.length === 0`) must report ≥44px tall CSS pixels.
// WCAG 2.5.5 Target Size (Level AA) + Maskin 44px design-principles rule.
// Desktop (fine pointer) rendering must be unchanged — the base `h-7` still wins.

const CHIP_LABELS = ['Help me plan a new bet', "What's the status on our current bets?"] as const

async function openSparseEmptyState(page: Page, workspaceId: string) {
	// Force the 0-item branch so the chips render regardless of what the real
	// backend seeds. Matches the existing foryou-sparse-composer.spec.ts pattern.
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})
	await page.goto(`/${workspaceId}`)
	const chips = page.getByTestId('sparse-composer-chips')
	await expect(chips).toBeVisible()
	return chips
}

async function assertMinHeight44(button: Locator, label: string, viewportLabel: string) {
	await expect(button, `${label} visible @ ${viewportLabel}`).toBeVisible()
	const box = await button.boundingBox()
	if (!box) throw new Error(`boundingBox missing for ${label} @ ${viewportLabel}`)
	expect(box.height, `${label} height ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
}

test.describe('SparseComposer quick-start chips — coarse pointer (touch)', () => {
	// hasTouch: true tells Chromium to report `pointer: coarse`, which is what
	// the CSS variant is gated on. Fine-pointer runs use the default context.
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`chips report ≥44px tall @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const chips = await openSparseEmptyState(page, account.workspaceId)

			for (const name of CHIP_LABELS) {
				const chip = chips.getByRole('button', { name, exact: true })
				await assertMinHeight44(chip, name, viewport.label)
			}
		})
	}
})

test.describe('SparseComposer quick-start chips — fine pointer (desktop)', () => {
	test('chips stay at ~28px on desktop (fine-pointer rendering unchanged)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		const chips = await openSparseEmptyState(page, account.workspaceId)

		// Base is `h-7` (28px). The `pointer-coarse:min-h-11` bump must NOT
		// apply on fine (mouse) pointers, so the chip stays below 44px.
		const chip = chips.getByRole('button', { name: 'Help me plan a new bet', exact: true })
		await expect(chip).toBeVisible()
		const box = await chip.boundingBox()
		if (!box) throw new Error('chip boundingBox missing on desktop')
		expect(box.height).toBeLessThan(44)
	})
})
