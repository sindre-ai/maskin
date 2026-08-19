import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression contract for the object-detail rebuild: the legacy
// ObjectDocumentView chrome — the always-mounted right rail and the
// edit-in-place title textarea — is gone. The v2 properties drawer replaces it
// and is off-canvas until the detail bar's toggle opens it (mockup 1371–1499),
// so the route must rest with no rail and no drawer sections on screen.
//
// The drawer's own behaviour — the toggle, ⌘/Ctrl+I, and `__chrome__`
// persistence — is covered by object-detail-properties.spec.ts. Status +
// Driver stay reachable from the hero identity row and, at narrow viewports,
// from the ⋯ menu's Properties group (aux-menu-properties.spec.ts).
test.describe('Object detail — no legacy properties rail', () => {
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

			// The drawer rests closed, so none of its sections are on screen. The
			// off-canvas drawer keeps its markup mounted and translates it past the
			// right edge, so this asserts it is out of the viewport rather than
			// absent from the DOM.
			await expect(page.getByRole('heading', { name: /^Files \(/ })).not.toBeInViewport()
			await expect(page.getByRole('button', { name: /add property/i })).not.toBeInViewport()

			// The only Properties affordance is the detail bar's toggle, and it
			// reports itself closed.
			const barToggle = page.locator('main header').first().getByRole('button', {
				name: 'Properties',
				exact: true,
			})
			await expect(barToggle).toBeVisible()
			await expect(barToggle).toHaveAttribute('aria-expanded', 'false')
		})
	}
})
