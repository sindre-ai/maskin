import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T4 of bet foryou-prototype-redesign — Today's brief panel.
// Opens as a right-rail at ≥1024 (feed stays visible) and as a Sheet overlay
// below. Audio + mentioned list wire to labeled empty states until the parallel
// briefing add-on bet lands the enriched API payload.
//
// The redesign is founder-gated by T1's useForyouRedesignFlag(). auth.fixture
// mints a random-UUID actor, so this spec flips the DEV localStorage override
// to land on the founder-flagged surface — same mechanism T5 uses.

async function enableRedesignFlag(page: Page) {
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem('maskin-flag-foryou-redesign', '1')
		} catch {
			// Storage not writable in some contexts — nothing else to fall back to.
		}
	})
}

test.describe("For You — Today's brief panel", () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`opens with audio + mentioned placeholders at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await enableRedesignFlag(page)
			await page.goto(`/${account.workspaceId}`)

			const trigger = page.getByRole('button', { name: /today's brief/i })
			await expect(trigger).toBeVisible({ timeout: 10000 })
			await trigger.click()

			await expect(
				page.getByText(/today's brief will appear here once the briefing pipeline lands/i),
			).toBeVisible()
			await expect(
				page.getByText(/mentioned items will appear here once the briefing pipeline lands/i),
			).toBeVisible()
		})
	}

	test('right-rail stays inline beside the redesign header at 1024 (feed does not disappear)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await enableRedesignFlag(page)
		await page.goto(`/${account.workspaceId}`)

		const trigger = page.getByRole('button', { name: /today's brief/i })
		await expect(trigger).toBeVisible({ timeout: 10000 })
		await trigger.click()

		const rail = page.getByRole('complementary', { name: /today's brief/i })
		await expect(rail).toBeVisible()
		// Redesign root is still visible alongside the rail.
		await expect(page.getByTestId('foryou-redesign-root')).toBeVisible()
		await expect(page.getByRole('heading', { name: 'For You', level: 1 })).toBeVisible()

		await page.getByRole('button', { name: /close today's brief/i }).click()
		await expect(rail).toBeHidden()
	})

	test('renders as a Sheet overlay at 375 (Escape closes it)', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await enableRedesignFlag(page)
		await page.goto(`/${account.workspaceId}`)

		const trigger = page.getByRole('button', { name: /today's brief/i })
		await expect(trigger).toBeVisible({ timeout: 10000 })
		await trigger.click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		await page.keyboard.press('Escape')
		await expect(dialog).toBeHidden()
	})
})
