import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Extensions moved out of Settings → General. A workspace enables one by
// installing the matching loop from the marketplace (Work Extension, Knowledge
// Extension, CRM Extension), so the toggle list and its removal dialog are gone
// from this page. The object types an enabled extension contributes are still
// configured under Settings → Objects — that tab must keep working.

test.describe('Settings — General', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders without an Extensions section at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings`)
			await page.waitForLoadState('load')

			// Positive assertion first so a blank/crashed page can't pass vacuously —
			// the sections that remain must actually be on screen.
			await expect(page.getByText('Workspace name')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Privacy & data')).toBeVisible()
			await expect(page.getByText('Appearance')).toBeVisible()

			await expect(page.getByText('Extensions', { exact: true })).toHaveCount(0)
			await expect(page.getByText('Enable or disable extensions for this workspace.')).toHaveCount(
				0,
			)
		})

		test(`Objects tab still configures object types at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/objects`)
			await page.waitForLoadState('load')

			await expect(page.getByRole('button', { name: /Add property/i }).first()).toBeVisible({
				timeout: 10000,
			})
		})
	}

	// The page uses colour tokens for its section borders and switches; both
	// modes are first-class, so check the surface renders in each.
	for (const scheme of ['light', 'dark'] as const) {
		test(`renders in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}/settings`)
			await page.waitForLoadState('load')

			await expect(page.getByText('Privacy & data')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Extensions', { exact: true })).toHaveCount(0)
		})
	}
})
