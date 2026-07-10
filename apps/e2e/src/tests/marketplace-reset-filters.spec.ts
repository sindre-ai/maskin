import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// M3: when a filter combo yields zero results, the marketplace must render an
// EmptyState with a Reset filters button that widens the filters back to All
// and swaps in the catalog grid. Reset button must meet the 44px tap-target
// floor on coarse (touch) pointers.

async function stubCatalogWithOneActor(page: import('@playwright/test').Page): Promise<void> {
	await page.route('**/api/catalog-packages**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				packages: [
					{
						id: 'p1',
						name: 'Solo Agent',
						slug: 'solo-agent',
						description: 'Just an agent',
						version: '1.0.0',
						use_case: 'Discovery',
						item_types: ['actor'],
						created_at: null,
						updated_at: null,
					},
				],
				counts: {
					total: 1,
					by_type: { actor: 1, trigger: 0, skill: 0, integration: 0 },
					by_use_case: { Discovery: 1 },
				},
			}),
		}),
	)
}

test.describe('Marketplace zero-results state — Reset filters', () => {
	test('narrowing the type filter to Integrations shows the EmptyState with a Reset button', async ({
		page,
		account,
	}) => {
		await stubCatalogWithOneActor(page)
		await page.goto(`/${account.workspaceId}/marketplace`)

		// The Agents section is visible before we narrow.
		await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible()

		// Pick the Integrations type filter — no packages match, so the
		// EmptyState should replace the grid.
		const integrationsButtons = page.getByRole('button', { name: /^Integrations/ })
		await integrationsButtons.last().click()

		await expect(page.getByText('No matches for this filter combo')).toBeVisible()
		const reset = page.getByRole('button', { name: 'Reset filters' })
		await expect(reset).toBeVisible()

		// Clicking Reset widens both filters back to All and the grid returns.
		await reset.click()
		await expect(page.getByText('No matches for this filter combo')).toBeHidden()
		await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible()
	})

	test('the empty-catalog copy (not filter-driven) still renders when the API returns zero packages', async ({
		page,
		account,
	}) => {
		await page.route('**/api/catalog-packages**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					packages: [],
					counts: { total: 0, by_type: {}, by_use_case: {} },
				}),
			}),
		)
		await page.goto(`/${account.workspaceId}/marketplace`)
		// Distinct copy — the two states must not collapse into each other.
		await expect(page.getByText(/No packages yet/i)).toBeVisible()
		await expect(page.getByText('No matches for this filter combo')).toBeHidden()
		await expect(page.getByRole('button', { name: 'Reset filters' })).toBeHidden()
	})

	test.describe('Reset filters button ≥44×44 CSS px @ coarse pointer', () => {
		test.use({ hasTouch: true })

		for (const viewport of SHIP_GATE_VIEWPORTS) {
			test(`hits the tap-target floor @ ${viewport.label}`, async ({ page, account }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await stubCatalogWithOneActor(page)
				await page.goto(`/${account.workspaceId}/marketplace`)

				// Narrow to a type filter with no matches so the Reset button renders.
				const integrationsButtons = page.getByRole('button', { name: /^Integrations/ })
				await integrationsButtons.last().click()

				const reset = page.getByRole('button', { name: 'Reset filters' })
				await expect(reset).toBeVisible()
				const box = await reset.boundingBox()
				if (!box) throw new Error(`Reset boundingBox missing @ ${viewport.label}`)
				expect(box.width, `Reset width ≥44 @ ${viewport.label}`).toBeGreaterThanOrEqual(44)
				expect(box.height, `Reset height ≥44 @ ${viewport.label}`).toBeGreaterThanOrEqual(44)
			})
		}
	})
})
