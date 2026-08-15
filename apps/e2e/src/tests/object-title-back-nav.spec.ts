import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression coverage for the customer-reported bug where the page-title
// textarea in ObjectDocumentView stayed stuck on the previous object's title
// after browser-back / sibling-to-sibling navigation. The route reuses the
// same component instance across the object.id change, so a useState
// initialiser alone can't reset the draft — the fix in
// apps/web/src/components/objects/object-document.tsx watches the id and
// resets titleDraft at render time. Playwright is the only harness that
// exercises the real router history stack, which is what the bug depended on.
test.describe('Object title back/forward navigation', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`page-title textarea swaps to match the current object @ ${vp.label}`, async ({
			page,
			account,
		}) => {
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

			// Open A first, confirm its title lands in the header textarea.
			await page.goto(`/${account.workspaceId}/objects/${objectA.id}`)
			const titleInput = page.getByPlaceholder('Untitled')
			await expect(titleInput).toHaveValue('Back-nav probe object A', { timeout: 10_000 })

			// Forward-nav to B — navigating via URL keeps the same route/component
			// instance, so this is the exact lifecycle the fix targets.
			await page.goto(`/${account.workspaceId}/objects/${objectB.id}`)
			await expect(titleInput).toHaveValue('Back-nav probe object B', { timeout: 10_000 })

			// Browser back — pre-fix this stayed on B's title; the fix resets the
			// draft on the id flip so A's title must reappear.
			await page.goBack()
			await expect(page).toHaveURL(new RegExp(`/objects/${objectA.id}$`))
			await expect(titleInput).toHaveValue('Back-nav probe object A', { timeout: 10_000 })

			// Browser forward — round-trip the swap once more so a partial fix
			// (e.g. only clearing on decreasing id order) can't sneak through.
			await page.goForward()
			await expect(page).toHaveURL(new RegExp(`/objects/${objectB.id}$`))
			await expect(titleInput).toHaveValue('Back-nav probe object B', { timeout: 10_000 })
		})
	}
})
