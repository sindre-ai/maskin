import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T2 (retain view state across in-app navigation) — silent restore of group
// expansion + first-visible-row scroll on the Objects list. Both fields are
// persisted through the existing per-actor display-settings row (extended in
// T1) and hydrated on the next mount.
test.describe('Objects list retains view state across back-nav', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`group expansion is restored after clicking into an object and back @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed two bets in two different statuses so grouping by status
			// produces multiple collapsed groups.
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Bet Alpha (active)',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Bet Beta (signal)',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet&groupBy=status`)

			// Groups render collapsed by default — the group header shows the
			// status label + count, and sub-rows are hidden until expanded.
			// Wait for the "active" group toggle as the ready signal.
			const activeGroupToggle = page.getByRole('button', {
				name: /active/i,
				expanded: false,
			})
			await expect(activeGroupToggle).toBeVisible({ timeout: 10_000 })

			// Expand the active group. Fire the click and wait for the
			// debounced PUT concurrently so the response isn't missed if the
			// toggle-driven write-through fires before we start listening.
			const [putResponse] = await Promise.all([
				page.waitForResponse(
					(r) => r.url().includes('/user-display-settings/bet') && r.request().method() === 'PUT',
					{ timeout: 10_000 },
				),
				activeGroupToggle.click(),
			])
			expect(putResponse.ok()).toBe(true)

			await expect(page.getByRole('button', { name: /active/i, expanded: true })).toBeVisible()
			await expect(page.getByText('Bet Alpha (active)')).toBeVisible()

			// Click into the object, then browser-back to the list.
			await page.getByText('Bet Alpha (active)').click()
			await expect(page).toHaveURL(/\/objects\//, { timeout: 10_000 })
			await page.goBack()

			// After silent restore, the "active" group is expanded again and
			// the row is visible.
			await expect(page.getByRole('button', { name: /active/i, expanded: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByText('Bet Alpha (active)')).toBeVisible()

			// Restore is silent: no toast, no banner, no "resume" affordance.
			await expect(page.locator('[role="status"]')).toHaveCount(0)
		})

		test(`scroll anchor is restored to the previously-first-visible row after back-nav @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed 60 bets so the list can scroll ~50 rows.
			for (let i = 0; i < 60; i++) {
				await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: `Scroll Anchor Row ${String(i).padStart(2, '0')}`,
					status: 'signal',
				})
			}

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			// Sorted by createdAt desc — the highest-numbered title (59) is at
			// the top. Wait for the first row to render before scrolling.
			await expect(page.getByText('Scroll Anchor Row 59')).toBeVisible({ timeout: 10_000 })

			// Scroll into the middle of the list. The exact anchor row is
			// picked from what's visible after the scroll settles.
			await page.evaluate(() => {
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (scroller) scroller.scrollTop = 2400
			})
			// Let the virtualiser render the new window.
			await page.waitForTimeout(300)

			// Capture the row currently at the top of the viewport.
			const firstVisibleRowText = await page.evaluate(() => {
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (!scroller) return null
				const scrollerRect = scroller.getBoundingClientRect()
				const rows = Array.from(scroller.querySelectorAll('[data-drag-row]'))
				for (const row of rows) {
					const rect = row.getBoundingClientRect()
					if (rect.bottom > scrollerRect.top + 1) return row.textContent
				}
				return null
			})
			expect(firstVisibleRowText).toBeTruthy()

			// Pick a row below the first-visible to click. Clicking fires the
			// route's captureViewState synchronously, which patches the
			// session view-state store with the first-visible row id before
			// the navigate. Restore on back-nav reads from that store.
			const clickTargetRowId = await page.evaluate(() => {
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (!scroller) return null
				const scrollerRect = scroller.getBoundingClientRect()
				const rows = Array.from(scroller.querySelectorAll('[data-drag-row]'))
				for (const row of rows) {
					const rect = row.getBoundingClientRect()
					if (rect.top > scrollerRect.top + 20) {
						return (row as HTMLElement).getAttribute('data-drag-row')
					}
				}
				return null
			})
			expect(clickTargetRowId).toBeTruthy()
			await page.locator(`[data-drag-row="${clickTargetRowId}"]`).click()
			await expect(page).toHaveURL(/\/objects\//, { timeout: 10_000 })
			await page.goBack()

			await expect(page.getByText(/Scroll Anchor Row \d+/).first()).toBeVisible({
				timeout: 10_000,
			})
			// Wait for the mount-time restore effect to run scrollToRowId
			// after the first row page arrives.
			await page.waitForTimeout(500)

			// The row that was first-visible before back-nav is at the top again.
			const restoredFirstVisibleRowText = await page.evaluate(() => {
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (!scroller) return null
				const scrollerRect = scroller.getBoundingClientRect()
				const rows = Array.from(scroller.querySelectorAll('[data-drag-row]'))
				for (const row of rows) {
					const rect = row.getBoundingClientRect()
					if (rect.bottom > scrollerRect.top + 1) return row.textContent
				}
				return null
			})
			expect(restoredFirstVisibleRowText).toBe(firstVisibleRowText)

			// No new resume UI element appears — restore is silent.
			await expect(page.locator('[role="status"]')).toHaveCount(0)
		})
	}
})
