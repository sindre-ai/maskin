import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Title fidelity across browser-back / sibling-to-sibling navigation. The
// rebuilt object-detail surface (bet/object-detail) renders the title as a
// static <h1> bound straight to the loaded object, so the class of bug this
// spec originally guarded — a stale useState title-draft left behind by the
// legacy ObjectDocumentView textarea after an id flip — is structurally
// impossible now: the root cause (stateful draft surviving the component
// instance reuse) no longer exists. What still needs guarding: the route must
// render *the current object's* title at every point in the history walk,
// with no stale UI from the previous object. Playwright is the only harness
// that exercises the real router history stack.
test.describe('Object title fidelity across back/forward navigation', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`static h1 swaps to match the current object @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const objectA = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Back-nav probe object A',
				status: 'signal',
			})
			const objectB = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Back-nav probe object B',
				status: 'signal',
			})

			// Open A first, confirm its title lands in the static heading.
			await page.goto(`/${account.workspaceId}/objects/${objectA.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Back-nav probe object A' }),
			).toBeVisible({ timeout: 10_000 })

			// Forward-nav to B — navigating via URL keeps the same route/component
			// instance, so this is the exact lifecycle the legacy bug depended on.
			await page.goto(`/${account.workspaceId}/objects/${objectB.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Back-nav probe object B' }),
			).toBeVisible({ timeout: 10_000 })

			// Browser back — the heading must show A again, not a stale draft.
			await page.goBack()
			await expect(page).toHaveURL(new RegExp(`/objects/${objectA.id}$`))
			await expect(
				page.getByRole('heading', { level: 1, name: 'Back-nav probe object A' }),
			).toBeVisible({ timeout: 10_000 })

			// Browser forward — round-trip the swap once more so a partial fix
			// (e.g. only clearing on one navigation direction) can't sneak through.
			await page.goForward()
			await expect(page).toHaveURL(new RegExp(`/objects/${objectB.id}$`))
			await expect(
				page.getByRole('heading', { level: 1, name: 'Back-nav probe object B' }),
			).toBeVisible({ timeout: 10_000 })
		})
	}
})
