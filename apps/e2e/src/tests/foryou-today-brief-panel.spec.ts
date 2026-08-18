import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The nav's Brief action opens a right-side drawer over the current screen
// (mockup 3414–3463) instead of navigating away. `/$workspaceId/briefing`
// stays as the deep-linkable full page for palette links and bookmarks.

test.describe('For You — Brief drawer', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`opens the brief as a drawer, not a navigation, at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)

			const trigger = page.getByRole('button', { name: /today.?s brief/i })
			await expect(trigger).toBeVisible({ timeout: 10000 })
			await trigger.click()

			const drawer = page.getByTestId('brief-drawer')
			await expect(drawer).toBeVisible()
			await expect(drawer).toContainText('Your brief')
			// The briefing markdown really rendered — the backend composes a
			// "{workspace name} — workspace briefing" heading.
			await expect(drawer.getByRole('heading', { name: /workspace briefing/i })).toBeVisible()
			// Still on For You — the drawer is an overlay, not a route change.
			expect(new URL(page.url()).pathname).toBe(`/${account.workspaceId}`)

			// No horizontal page scrollbar while the drawer is open.
			const { scrollWidth, innerWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1)

			await page.keyboard.press('Escape')
			await expect(drawer).toHaveCount(0)
		})
	}
})
