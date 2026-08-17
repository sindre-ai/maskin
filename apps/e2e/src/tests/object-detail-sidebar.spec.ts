import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression contract for the bet/object-detail rebuild: the legacy
// ObjectDocumentView properties right sidebar (Metadata / Files / Subscribe /
// timestamps) and its edit-in-place title textarea are not part of the
// reconstructed surface per the bet's page enumeration — T1's static shell
// owns header, ask banner, and body, and nothing else on the route may mount
// the old chrome.
//
// What this file used to exercise — the ⌘/Ctrl+I toggle, `__chrome__`
// user-display-settings persistence, and breakpoint defaults (Sheet at 375 /
// 44 px rail at 768 / 288 px inline at 1024) — is gone with the surface.
// Status + Driver remain reachable: hoisted into the hero identity row, and
// graduated into the shipped ⋯ menu's Properties group at narrow viewports
// (covered by aux-menu-properties.spec.ts).
test.describe('Object detail — no legacy properties sidebar', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shell renders with no properties-sidebar chrome @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Sidebar absence probe',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			// The shell exposes the title as a static h1 — proves the route loaded
			// before the absence assertions run. The old textarea is never present.
			await expect(
				page.getByRole('heading', { level: 1, name: 'Sidebar absence probe' }),
			).toBeVisible({ timeout: 10_000 })
			await expect(page.getByPlaceholder('Untitled')).toHaveCount(0)

			// No Properties collapse toggle (the sidebar's exact-match-header
			// button). The ⋯ menu's "Properties" label is a DropdownMenuLabel,
			// not a button, so this can't collide with it.
			await expect(page.getByRole('button', { name: 'Properties', exact: true })).toHaveCount(0)
			// No Files section, no Metadata "+ Add property" trigger.
			await expect(page.getByRole('heading', { name: /^Files \(/ })).toHaveCount(0)
			await expect(page.getByRole('button', { name: /add property/i })).toHaveCount(0)
		})
	}
})
