import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The rebuilt object-detail shell keeps the properties drawer, but moves it
// behind an explicit toggle on the page bar: the document itself reads as
// title + body + activity, and the drawer rests closed until asked for. This
// spec pins that resting shape — the body carries the hypothesis on its own,
// and no drawer overlay is mounted before the toggle is used. The drawer's own
// behaviour (sections, chord, persistence) lives in
// object-detail-properties.spec.ts.

test.describe('Bet detail — document reads without the properties drawer', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`body carries the hypothesis and the drawer rests closed at ${viewport.label}`, async ({
			page,
			account,
		}) => {
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

			// The toggle is present on every ship-gate viewport, and the drawer it
			// governs is closed on first paint — no overlay dialog is mounted.
			const toggle = page.getByRole('button', { name: 'Properties', exact: true })
			await expect(toggle).toBeVisible()
			await expect(toggle).toHaveAttribute('aria-expanded', 'false')
			await expect(page.getByRole('dialog')).toHaveCount(0)
		})
	}
})
