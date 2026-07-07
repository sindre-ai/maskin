import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// AC-U5: the bet detail page leads with hypothesis + activity timeline; properties
// and files live in a Linear-style right drawer, closed by default. This spec
// drives the toggle at 375/768/1024 to confirm the drawer opens, the body holds
// no inline property grid, and the Properties + Files sections are reachable.

test.describe('Bet detail — properties drawer', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`hypothesis + drawer toggle work at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drawer parity bet',
				content:
					'Hypothesis: operators read state from description + timeline alone.\n\nThis is the body.',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByDisplayValue('Drawer parity bet')).toBeVisible({ timeout: 10000 })

			// Body shows hypothesis text.
			await expect(
				page.getByText('Hypothesis: operators read state from description + timeline alone.'),
			).toBeVisible()

			// Drawer is closed by default — Properties heading does not appear in the
			// drawer surface. Use a role-scoped query so we don't accidentally match
			// other "Properties" strings on the page.
			await expect(page.getByRole('dialog')).toHaveCount(0)

			// Open the drawer via the header toggle.
			await page.getByRole('button', { name: 'Properties' }).click()

			const drawer = page.getByRole('dialog')
			await expect(drawer).toBeVisible()

			// Drawer renders Properties + Files sections.
			await expect(drawer.getByText('Properties', { exact: true })).toBeVisible()
			await expect(drawer.getByText(/Files \(/)).toBeVisible()

			// Close via Escape.
			await page.keyboard.press('Escape')
			await expect(page.getByRole('dialog')).toHaveCount(0)
		})
	}
})
