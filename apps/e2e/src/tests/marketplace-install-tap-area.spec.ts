import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// M7: on coarse (touch) pointers the Install button on every marketplace ItemCard
// must report ≥44 CSS-pixel tall hit area. WCAG 2.5.5 Target Size (Level AA) +
// Maskin 44px design-principles rule (apps/web/CLAUDE.md). Fine-pointer (desktop)
// rendering must be unchanged — the Tailwind `pointer-coarse:` variant is
// additive so mouse users keep the compact h-7 button.

const PACKAGE_ID = 'pkg-bundle-1'
const ITEM_ID = 'item-actor-1'

async function mockCatalog(page: Page): Promise<void> {
	await page.route('**/api/catalog/packages*', async (route, req) => {
		if (req.url().includes('/packages/')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					package: {
						id: PACKAGE_ID,
						name: 'Sample Bundle',
						slug: 'sample-bundle',
						description: 'Bundle used to render marketplace ItemCards.',
						version: '1.0.0',
						use_case: 'Discovery',
						item_types: ['actor', 'trigger'],
						created_at: null,
						updated_at: null,
					},
					items: [
						{
							id: ITEM_ID,
							package_id: PACKAGE_ID,
							item_type: 'actor',
							source_item_id: 'src-actor-1',
							item_snapshot: {
								name: 'Sample Agent',
								description: 'Rendered on the marketplace as an ItemCard.',
							},
							created_at: null,
						},
					],
				}),
			})
			return
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				packages: [
					{
						id: PACKAGE_ID,
						name: 'Sample Bundle',
						slug: 'sample-bundle',
						description: 'Bundle used to render marketplace ItemCards.',
						version: '1.0.0',
						use_case: 'Discovery',
						item_types: ['actor', 'trigger'],
						created_at: null,
						updated_at: null,
					},
				],
				counts: {
					total: 1,
					by_type: { actor: 1, trigger: 1, skill: 0, integration: 0 },
					by_use_case: { Discovery: 1 },
				},
			}),
		})
	})

	await page.route('**/api/catalog/items/installed*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})

	await page.route('**/api/installed-packages*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ installs: [] }),
		})
	})
}

async function gotoMarketplace(page: Page, workspaceId: string) {
	await mockCatalog(page)
	await page.goto(`/${workspaceId}/marketplace`)
	// Wait until the ItemCard renders its Install button before measuring.
	const button = page.getByRole('button', { name: /^install$/i }).first()
	await expect(button).toBeVisible({ timeout: 10000 })
	return button
}

test.describe('Marketplace ItemCard — Install button tap target (coarse pointer)', () => {
	// hasTouch tells Chromium to advertise `pointer: coarse`, which is what the
	// Tailwind variant is gated on. Fine-pointer runs use the default context.
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Install button ≥44 CSS px tall @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const button = await gotoMarketplace(page, account.workspaceId)
			const box = await button.boundingBox()
			if (!box) throw new Error(`Install button has no layout box @ ${viewport.label}`)
			expect(box.height, `Install height ≥44 @ ${viewport.label}`).toBeGreaterThanOrEqual(44)
		})
	}
})

test.describe('Marketplace ItemCard — Install button tap target (fine pointer)', () => {
	test('Install button keeps the compact h-7 rendering on desktop', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		const button = await gotoMarketplace(page, account.workspaceId)
		const box = await button.boundingBox()
		if (!box) throw new Error('Install button has no layout box on desktop')
		expect(box.height).toBeLessThan(44)
	})
})
