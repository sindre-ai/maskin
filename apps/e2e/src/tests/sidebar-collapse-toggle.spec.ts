import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// The left-nav collapse toggle was a `SidebarTrigger` in the sidebar header before
// the sidebar-legibility redesign. That header now hosts the workspace pill, and the
// header's own `SidebarTrigger` was `md:hidden` (mobile hamburger only) — leaving no
// visible desktop toggle. This spec locks in that the top-header toggle is visible on
// desktop viewports and actually collapses / expands the sidebar shell.

test.describe('Left-nav collapse toggle', () => {
	for (const viewport of [VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]) {
		test(`collapses and expands the sidebar at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

			const sidebar = page.locator('[data-side="left"]').first()
			await expect(sidebar).toHaveAttribute('data-state', 'expanded')

			const trigger = page.getByRole('button', { name: /toggle sidebar/i }).first()
			await expect(trigger).toBeVisible()

			await trigger.click()
			await expect(sidebar).toHaveAttribute('data-state', 'collapsed')

			await trigger.click()
			await expect(sidebar).toHaveAttribute('data-state', 'expanded')
		})
	}
})
