import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Settings — Integrations page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders integrations list at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// Page should load without error — at minimum the provider list is visible.
			// `.first()` avoids a strict-mode violation now that both Gmail and Google
			// Calendar providers render at once.
			await expect(
				page
					.getByRole('heading', { name: 'Integrations' })
					.or(page.locator('text=Google Calendar').or(page.locator('text=Gmail')))
					.first(),
			).toBeVisible({ timeout: 10000 })
		})

		test(`"Available to connect" label visible for unconnected providers at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// `load` instead of `networkidle` — the app holds an SSE connection to
			// /api/events, so networkidle never fires. Brief settle after `load`.
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			// Google Calendar has no event types defined yet (T2/T3), so it should
			// show "Available to connect" rather than "0 event types available".
			// Assert the positive side so a blank/crashed page doesn't pass vacuously.
			await expect(page.getByText('Available to connect').first()).toBeVisible()
			await expect(page.locator('text=0 event types available')).not.toBeVisible()
		})
	}

	test('Connect button is reachable at all viewports', async ({ page, account }) => {
		for (const viewport of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			// `load` instead of `networkidle` — the app holds an SSE connection to
			// /api/events, so networkidle never fires. Brief settle after `load`.
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			// At least one Connect button must be visible — a fresh test account has
			// no connected integrations, so every provider shows a Connect button.
			// Unconditional: if zero buttons are found, the test correctly fails.
			await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible()
		}
	})
})
