import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// When the proxy has no healthy backend it answers every /api call with a bare
// HTML 503 ("Site not available"). The browser is online, so the old banner
// stayed silent and each screen failed in its own way. The app now says so once,
// at the top, and clears it (and retries what failed) when the server returns.

const BANNER = /Can.t reach Maskin/

const GATEWAY_DOWN = {
	status: 503,
	contentType: 'text/html',
	body: '<!DOCTYPE html><html><head><title>Site not available</title></head><body>Site not available</body></html>',
}

async function takeServerDown(page: Page) {
	await page.route('**/api/**', (route) => route.fulfill(GATEWAY_DOWN))
}

async function bringServerBack(page: Page) {
	await page.unroute('**/api/**')
	// The tab regaining focus probes /api/health straight away rather than
	// waiting out the backoff, which is also what a person returning to the tab does.
	await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

test.describe('Server unreachable banner', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows while the server is down and clears when it returns at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await takeServerDown(page)
			await page.goto(`/${account.workspaceId}`)

			const banner = page.getByRole('status').filter({ hasText: BANNER })
			await expect(banner).toBeVisible({ timeout: 20_000 })

			// The banner must not push the page sideways on a narrow screen.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			await bringServerBack(page)
			await expect(banner).toBeHidden({ timeout: 20_000 })
			// Whatever gave up during the outage retried by itself — no reload.
			await expect(page.getByText('Something went wrong')).toBeHidden({ timeout: 20_000 })
		})
	}

	for (const colorScheme of ['light', 'dark'] as const) {
		test(`banner is readable in ${colorScheme} mode`, async ({ page, account }) => {
			await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
			await page.emulateMedia({ colorScheme })
			await takeServerDown(page)
			await page.goto(`/${account.workspaceId}`)

			const banner = page.getByRole('status').filter({ hasText: BANNER })
			await expect(banner).toBeVisible({ timeout: 20_000 })
			const { color, background } = await banner.evaluate((el) => {
				const style = getComputedStyle(el)
				return { color: style.color, background: style.backgroundColor }
			})
			expect(color).not.toBe(background)
		})
	}

	test('does not show for a single failed request when the server is healthy', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.tabletPortrait.width, height: 1024 })
		let failed = false
		// One slow endpoint times out; /api/health and everything else is fine.
		await page.route('**/api/actors/**', (route) => {
			if (failed) return route.continue()
			failed = true
			return route.fulfill(GATEWAY_DOWN)
		})
		await page.goto(`/${account.workspaceId}`)
		await page.waitForLoadState('networkidle')
		await expect(page.getByRole('status').filter({ hasText: BANNER })).toHaveCount(0)
	})
})
