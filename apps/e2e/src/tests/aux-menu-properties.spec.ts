import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// The ⋯ menu on a bet detail page used to grow a Properties group (Status +
// Driver) at narrow-desktop and mobile, so the sticky nav could compact. The
// v2 shell retired that group: those controls duplicated the right Properties
// drawer, which has its own button on every viewport. This spec now pins the
// replacement contract — Status/Driver live in exactly one place, and that
// place is reachable at every ship-gate viewport.
const NARROW_DESKTOP = { width: 1000, height: 768, label: 'narrow desktop (1000×768)' }

test.describe('AuxiliaryActionMenu — no duplicated properties on bet detail', () => {
	for (const vp of [
		VIEWPORTS.mobile,
		NARROW_DESKTOP,
		{ width: 1440, height: 900, label: 'wide desktop (1440×900)' },
	]) {
		test(`the ⋯ menu carries no Status/Driver rows @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Aux properties probe ${vp.width}`,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByPlaceholder('Untitled')).toHaveValue(bet.title ?? '', {
				timeout: 10_000,
			})

			await page.getByRole('button', { name: /more actions/i }).click()

			// Scoped to the menu/sheet the trigger just opened — the object-detail
			// sidebar has its own legitimate "Properties" label and Status row.
			const menu = page.getByRole('menu').or(page.getByRole('dialog'))
			await expect(menu.getByText(/^Status$/)).toHaveCount(0)
			await expect(menu.getByText(/^Driver$/)).toHaveCount(0)
			await expect(menu.getByText(/^Properties$/i)).toHaveCount(0)
		})
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the Properties drawer is reachable @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Aux properties drawer ${vp.width}`,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByPlaceholder('Untitled')).toHaveValue(bet.title ?? '', {
				timeout: 10_000,
			})

			// The single home for Status/Driver editing, on every viewport — this is
			// what justifies dropping them from the ⋯ menu.
			//
			// Scoped to the header and exact: the fixture builds the workspace name
			// out of the test title (auth.fixture.ts), so the switcher's aria-label
			// contains the word "Properties" on this very test — and a non-exact
			// name match is a case-insensitive substring, which also catches the
			// sidebar's own "Expand properties" / "File properties" buttons.
			await expect(
				page.locator('header').getByRole('button', { name: 'Properties', exact: true }),
			).toBeVisible()
		})
	}
})
