import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// M1: when the catalog fetch fails, the marketplace must offer a Retry that
// re-fires the query without a full-page reload, meet the 44px tap-target
// floor on coarse (touch) pointers, and surface a one-line diagnostic when
// the URL carries a `?error=` param.

async function forceCatalogError(page: import('@playwright/test').Page): Promise<void> {
	await page.route('**/api/catalog-packages**', (route) =>
		route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: '{"error":"unavailable"}',
		}),
	)
}

test.describe('Marketplace error state — Retry + diagnostic', () => {
	test('successful retry replaces the error state with the catalog grid', async ({
		page,
		account,
	}) => {
		let requestCount = 0
		await page.route('**/api/catalog-packages**', (route) => {
			requestCount += 1
			if (requestCount === 1) {
				return route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: '{"error":"unavailable"}',
				})
			}
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					packages: [],
					counts: { total: 0, by_type: {}, by_use_case: {} },
				}),
			})
		})

		await page.goto(`/${account.workspaceId}/marketplace`)
		await expect(page.getByText(/Couldn't load the catalog/i)).toBeVisible()

		const retry = page.getByRole('button', { name: /^Retry$/ })
		await expect(retry).toBeVisible()
		await retry.click()

		await expect(page.getByText(/Couldn't load the catalog/i)).toBeHidden()
		// Empty-state copy proves the successful branch rendered.
		await expect(page.getByText(/No packages yet/i)).toBeVisible()
		expect(requestCount).toBeGreaterThanOrEqual(2)
	})

	test('diagnostic line renders when the URL carries ?error=', async ({ page, account }) => {
		await forceCatalogError(page)
		await page.goto(
			`/${account.workspaceId}/marketplace?error=${encodeURIComponent('503 — try again in a minute')}`,
		)
		await expect(page.getByText(/Couldn't load the catalog/i)).toBeVisible()
		await expect(page.getByText('503 — try again in a minute')).toBeVisible()
	})

	test('diagnostic line is absent when ?error= is not supplied', async ({ page, account }) => {
		await forceCatalogError(page)
		await page.goto(`/${account.workspaceId}/marketplace`)
		await expect(page.getByText(/Couldn't load the catalog/i)).toBeVisible()
		await expect(page.getByText(/503|Network error/)).toBeHidden()
	})

	test.describe('Retry button ≥44×44 CSS px @ coarse pointer', () => {
		test.use({ hasTouch: true })

		for (const viewport of SHIP_GATE_VIEWPORTS) {
			test(`hits the tap-target floor @ ${viewport.label}`, async ({ page, account }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await forceCatalogError(page)
				await page.goto(`/${account.workspaceId}/marketplace`)

				const retry = page.getByRole('button', { name: /^Retry$/ })
				await expect(retry).toBeVisible()
				const box = await retry.boundingBox()
				if (!box) throw new Error(`Retry boundingBox missing @ ${viewport.label}`)
				expect(box.width, `Retry width ≥44 @ ${viewport.label}`).toBeGreaterThanOrEqual(44)
				expect(box.height, `Retry height ≥44 @ ${viewport.label}`).toBeGreaterThanOrEqual(44)
			})
		}
	})
})
