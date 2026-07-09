import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// AC-T6 / AC-U1: at viewports ≤1024 CSS px, the rendered row-select checkbox
// hit area must be ≥44×44 CSS px, centered on the visible checkbox, and a
// synthetic touch up to 21px off-center must still toggle selection.

const TOUCH_VIEWPORTS = [VIEWPORTS.mobile, VIEWPORTS.tabletPortrait, VIEWPORTS.tabletLandscape]

async function seedTwoObjects(account: {
	api: { createObject: (wsId: string, body: Record<string, unknown>) => Promise<{ id: string }> }
	workspaceId: string
}) {
	await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Bulk Select Bet A',
		status: 'signal',
	})
	await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Bulk Select Bet B',
		status: 'signal',
	})
}

async function firstRowCheckbox(page: Page): Promise<Locator> {
	const cb = page.getByRole('checkbox', { name: 'Select row' }).first()
	await expect(cb).toBeVisible({ timeout: 10000 })
	return cb
}

async function requireBox(locator: Locator, label: string) {
	const box = await locator.boundingBox()
	if (!box) throw new Error(`boundingBox missing for ${label}`)
	return box
}

test.describe('iOS bulk-select checkbox tap area (T1)', () => {
	for (const viewport of TOUCH_VIEWPORTS) {
		test(`row-select checkbox is ≥44×44 CSS px at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await seedTwoObjects(account)
			await page.goto(`/${account.workspaceId}/objects`)

			const cb = await firstRowCheckbox(page)
			const box = await requireBox(cb, `row checkbox at ${viewport.label}`)
			expect(box.width, `width ≥44 at ${viewport.label}`).toBeGreaterThanOrEqual(44)
			expect(box.height, `height ≥44 at ${viewport.label}`).toBeGreaterThanOrEqual(44)
		})

		test(`tap 21px off-center on the row-select checkbox toggles selection at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await seedTwoObjects(account)
			await page.goto(`/${account.workspaceId}/objects`)

			const cb = await firstRowCheckbox(page)
			const box = await requireBox(cb, `row checkbox at ${viewport.label}`)
			// Tap 21px off-center along x; must still land inside the 44px hit area.
			await page.mouse.click(box.x + box.width / 2 + 21, box.y + box.height / 2)
			await expect(cb).toHaveAttribute('aria-checked', 'true')
		})
	}

	test('desktop (1440px) keeps the 16px visible checkbox — touch variant only kicks in ≤1024px', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		await seedTwoObjects(account)
		await page.goto(`/${account.workspaceId}/objects`)

		const cb = await firstRowCheckbox(page)
		const box = await requireBox(cb, 'desktop row checkbox')
		expect(box.width).toBeLessThan(44)
		expect(box.height).toBeLessThan(44)
	})
})
