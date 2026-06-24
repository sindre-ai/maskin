import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression test for the bug where toggling a property in the Display panel
// on the Objects All tab was lost on navigation/reload. The fix routes the
// All tab through the same per-actor persistence as type tabs, using the
// `__all__` sentinel slot so its column-visibility state has somewhere to
// live (typed rows alone don't cover the All tab — its `object_type` is
// undefined).
test.describe('Objects display-panel persistence', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`toggling a property on the All tab survives reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed an object so the toolbar renders and the table mounts.
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Display Persistence Probe',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Display Persistence Probe')).toBeVisible({ timeout: 10_000 })

			// "Created by" is one of the static columns that can be toggled in the
			// Display panel's Properties section. The route's initial state hides it
			// (`columnVisibility = { createdBy: false }`), so toggling makes it
			// visible — that flip is what must survive a reload.
			await page.getByRole('button', { name: /^Display/ }).click()
			const createdByPill = page.getByRole('dialog').getByRole('button', { name: /Created by/i })
			await expect(createdByPill).toBeVisible()

			// Register the listener before triggering the toggle so we cannot miss
			// the request. The write-through debounces 500 ms after the state
			// change — waitForResponse blocks until the response arrives, making
			// the wait deterministic instead of time-bound.
			const settingsSaved = page.waitForResponse(
				(r) => r.url().includes('/user-display-settings/__all__') && r.request().method() === 'PUT',
			)
			await createdByPill.click()
			// Close the popover so the column-header assertion below isn't shadowed.
			await page.keyboard.press('Escape')
			await settingsSaved

			await page.reload()
			await expect(page.getByText('Display Persistence Probe')).toBeVisible({ timeout: 10_000 })

			// Re-open the panel and assert the pill is still in its toggled state —
			// the active-pill style applies `bg-accent text-accent-foreground`, but
			// the simpler assertion is "open the panel, see it active". Use
			// aria-pressed if the PillButton sets it, otherwise fall back to the
			// active class. PillButton renders `border-accent` when active.
			await page.getByRole('button', { name: /^Display/ }).click()
			const createdByPillAfter = page.getByRole('dialog').getByRole('button', {
				name: /Created by/i,
			})
			await expect(createdByPillAfter).toBeVisible()
			// PillButton applies `border-accent` when active and `border-border`
			// when inactive. Read class once to avoid coupling to internal markup.
			const className = await createdByPillAfter.getAttribute('class')
			expect(className ?? '').toContain('border-accent')
		})
	}
})
