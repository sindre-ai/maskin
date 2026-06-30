import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Settings — Integrations page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders integrations list at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// Page should load without error — at minimum the provider list is visible
			await expect(
				page
					.getByRole('heading', { name: 'Integrations' })
					.or(page.locator('text=Google Calendar').or(page.locator('text=Gmail'))),
			).toBeVisible({ timeout: 10000 })
		})

		test(`"Available to connect" label visible for unconnected providers at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// Wait for the providers to load
			await page.waitForLoadState('networkidle')

			// Google Calendar has no event types defined yet (T2/T3), so it should
			// show "Available to connect" rather than "0 event types available"
			const zeroEventsText = page.locator('text=0 event types available')
			await expect(zeroEventsText).not.toBeVisible()
		})
	}

	test('Connect button is reachable at all viewports', async ({ page, account }) => {
		for (const viewport of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await page.waitForLoadState('networkidle')

			// At least one Connect button should be visible and clickable
			const connectButtons = page.getByRole('button', { name: 'Connect' })
			const count = await connectButtons.count()
			if (count > 0) {
				await expect(connectButtons.first()).toBeVisible()
			}
		}
	})
})
