import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The rebuilt object-detail shell (bet/object-detail, T1) retires the right
// sidebar / properties drawer: non-private metadata renders as key/value rows
// in the body, and there is no "Properties" toggle or overlay sheet. The
// retired surface is pinned as an absence/regression contract here (the
// object-detail-sidebar spec does the same from the other side) until a
// later task re-introduces properties chrome.

test.describe('Bet detail — properties drawer retired', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`properties drawer surface is absent at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drawer parity bet',
				content:
					'Hypothesis: operators read state from description + timeline alone.\n\nThis is the body.',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			// The title is a static <h1> on the rebuilt surface.
			await expect(page.getByRole('heading', { level: 1, name: 'Drawer parity bet' })).toBeVisible({
				timeout: 10000,
			})

			// Body shows hypothesis text.
			await expect(
				page.getByText('Hypothesis: operators read state from description + timeline alone.'),
			).toBeVisible()

			// No sidebar toggle button, no overlay dialog, no "Properties" chrome.
			await expect(page.getByRole('button', { name: 'Properties', exact: true })).toHaveCount(0)
			await expect(page.getByRole('dialog')).toHaveCount(0)
		})
	}
})
