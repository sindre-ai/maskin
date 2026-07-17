import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T5: the Settings › Integrations page carries a LinkedIn provider row that is
// a secondary Connect entrance for the Unipile hosted-auth flow. Assert the
// row renders in the not-connected state at every ship-gate viewport and that
// clicking Connect hands the browser off to the Unipile URL (stubbed so no
// real Unipile call is made).

test.describe('LinkedIn provider row on Settings › Integrations', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the LinkedIn row and hands off to Unipile at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const stubUrl = 'http://localhost:5173/__linkedin_settings_stub'
			await page.route('**/api/linkedin/connect', async (route) => {
				const body = route.request().postDataJSON() as { return_path?: string }
				// Sanity: Settings must send the return_path so the callback lands
				// back on Settings, not on the agent detail page.
				expect(body.return_path).toBe(`/${account.workspaceId}/settings/integrations`)
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ url: stubUrl }),
				})
			})
			await page.route('**/api/linkedin/account', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: 'null',
				})
			})
			await page.route('**/__linkedin_settings_stub', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'text/html',
					body: '<!doctype html><title>stub</title>ok',
				})
			})

			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await page.waitForLoadState('load')

			// The LinkedIn row lives inside the main content area — scope out the
			// workspace-switcher (which carries the account title in its aria-label)
			// to keep strict-mode happy.
			const main = page.locator('main')
			const linkedinRow = main
				.locator('div')
				.filter({ hasText: /^LinkedIn/ })
				.first()
			await expect(linkedinRow).toBeVisible({ timeout: 10000 })
			await expect(linkedinRow.getByText('Available to connect')).toBeVisible()

			const connectButton = linkedinRow.getByRole('button', { name: 'Connect' })
			await expect(connectButton).toBeVisible()

			const nav = page.waitForURL('**/__linkedin_settings_stub', { timeout: 10000 })
			await connectButton.click()
			await nav
			expect(page.url()).toContain('/__linkedin_settings_stub')
		})
	}
})
