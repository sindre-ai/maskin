import { expect, test } from '../fixtures/auth.fixture'

// Regression test for the bug where toggling a property in the Display panel
// on the Objects All tab was lost on navigation/reload. The fix routes the
// All tab through the same per-actor persistence as type tabs, using the
// `__all__` sentinel slot so its column-visibility state has somewhere to
// live (typed rows alone don't cover the All tab — its `object_type` is
// undefined).
test.describe('Objects display-panel persistence', () => {
	test('toggling a property on the All tab survives reload', async ({ page, account }) => {
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
		await createdByPill.click()
		// Close the popover so the column-header assertion below isn't shadowed.
		await page.keyboard.press('Escape')

		// Wait for the write-through debounce (500 ms) plus a margin before
		// reloading, otherwise the test races the upsert.
		await page.waitForTimeout(900)

		await page.reload()
		await expect(page.getByText('Display Persistence Probe')).toBeVisible({ timeout: 10_000 })

		// Re-open the panel and assert the pill is still in its toggled state —
		// the active-pill style applies `bg-accent text-accent-foreground`, but
		// the simpler assertion is "open the panel, see it active". Use
		// aria-pressed if the PillButton sets it, otherwise fall back to the
		// active class. PillButton renders `border-accent` when active.
		await page.getByRole('button', { name: /^Display/ }).click()
		const createdByPillAfter = page.getByRole('dialog').getByRole('button', { name: /Created by/i })
		await expect(createdByPillAfter).toBeVisible()
		// PillButton applies `border-accent` when active and `border-border`
		// when inactive. Read class once to avoid coupling to internal markup.
		const className = await createdByPillAfter.getAttribute('class')
		expect(className ?? '').toContain('border-accent')
	})
})
