import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// M6: on coarse (touch) pointers the mobile filter chips at the top of
// /marketplace must report ≥44px tall CSS pixels. WCAG 2.5.5 Target Size
// (Level AA) + Maskin 44px design-principles rule. Desktop (fine pointer,
// ≥md) uses the sidebar and the chip strip is `md:hidden` there, so
// desktop chrome is unaffected — but the fine-pointer control below still
// asserts the chip doesn't grow when the strip is force-rendered.

async function openMarketplaceChips(page: Page, workspaceId: string) {
	// Deterministic catalog counts so the chip strip always renders with the
	// same set of labels regardless of what the real backend seeds.
	await page.route('**/api/catalog/packages**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				packages: [],
				counts: {
					total: 0,
					by_type: { actor: 0, trigger: 0, skill: 0, integration: 0 },
					by_use_case: { Discovery: 0, Sales: 0, Research: 0, 'Lifecycle comms': 0 },
				},
			}),
		})
	})
	await page.goto(`/${workspaceId}/marketplace`)
	const chipNav = page.getByRole('navigation', { name: 'Marketplace filters' })
	await expect(chipNav).toBeAttached()
	return chipNav
}

async function assertMinHeight44(chip: Locator, label: string, viewportLabel: string) {
	await expect(chip, `${label} visible @ ${viewportLabel}`).toBeVisible()
	const box = await chip.boundingBox()
	if (!box) throw new Error(`boundingBox missing for ${label} @ ${viewportLabel}`)
	expect(box.height, `${label} height ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
}

test.describe('Marketplace filter chips — coarse pointer (touch)', () => {
	// hasTouch: true makes Chromium report `pointer: coarse`, which the
	// `pointer-coarse:` variant is gated on.
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`chips report ≥44px tall @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const chipNav = await openMarketplaceChips(page, account.workspaceId)

			// The mobile chip nav is `md:hidden`. Only the mobile viewport (375)
			// keeps it visible; at 768 / 1024 the desktop sidebar takes over.
			// Assert visibility per viewport before measuring.
			if (viewport.width < 768) {
				await expect(chipNav).toBeVisible()
				const chips = chipNav.locator('button[type="button"]')
				const count = await chips.count()
				expect(count, `at least one filter chip renders @ ${viewport.label}`).toBeGreaterThan(0)
				for (let i = 0; i < count; i++) {
					const chip = chips.nth(i)
					const label = (await chip.textContent())?.trim() ?? `chip ${i}`
					await assertMinHeight44(chip, label, viewport.label)
				}
			} else {
				// At ≥md the chip strip is display:none. The sidebar takes over.
				await expect(chipNav).toBeHidden()
			}
		})
	}
})

test.describe('Marketplace filter chips — fine pointer (desktop)', () => {
	test('base chip height stays under 44px on fine pointer (desktop chrome unchanged)', async ({
		page,
		account,
	}) => {
		// Force the mobile viewport so the chip strip renders, but keep the
		// default fine-pointer context so `pointer-coarse:min-h-11` does NOT
		// apply. Base is `px-3 py-1 text-xs` — well under 44px.
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})
		const chipNav = await openMarketplaceChips(page, account.workspaceId)
		await expect(chipNav).toBeVisible()
		const firstChip = chipNav.locator('button[type="button"]').first()
		await expect(firstChip).toBeVisible()
		const box = await firstChip.boundingBox()
		if (!box) throw new Error('chip boundingBox missing on fine pointer')
		expect(box.height).toBeLessThan(44)
	})
})
