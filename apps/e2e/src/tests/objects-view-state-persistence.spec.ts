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
			await expect(page.getByText('Bet Alpha (active)')).toBeVisible({ timeout: 10_000 })

			// Groups render collapsed by default. Expand the "active" group.
			const activeGroupToggle = page.getByRole('button', { name: /active/i, expanded: false })
			await activeGroupToggle.click()
			await expect(page.getByRole('button', { name: /active/i, expanded: true })).toBeVisible()

			// Wait for the write-through debounce to persist through the shared
			// display-settings PUT rail.
			await page.waitForResponse(
				(r) =>
					r.url().includes('/user-display-settings/bet') && r.request().method() === 'PUT',
				{ timeout: 5_000 },
			)

			// Click into an object, then browser-back to the list.
			await page.getByText('Bet Alpha (active)').click()
			await expect(page).toHaveURL(/\/objects\//, { timeout: 10_000 })
			await page.goBack()
			await expect(page.getByText('Bet Alpha (active)')).toBeVisible({ timeout: 10_000 })

			// Restore is silent: no toast, no banner, no "resume" affordance.
			await expect(page.locator('[role="status"]')).toHaveCount(0)

			// The active group is expanded again after back-nav.
			await expect(
				page.getByRole('button', { name: /active/i, expanded: true }),
			).toBeVisible({ timeout: 5_000 })
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
			await page.getByText('Scroll Anchor Row 59').scrollIntoViewIfNeeded()
			await page.evaluate(() => {
				// Scroll the nearest overflow container ~50 rows down (~2400px).
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (scroller) scroller.scrollTop = 2400
			})

			// Wait for the write-through debounce to fire.
			await page.waitForResponse(
				(r) =>
					r.url().includes('/user-display-settings/bet') && r.request().method() === 'PUT',
				{ timeout: 5_000 },
			)

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

			// Click into the first visible row (find one that is clickable) and
			// then browser-back.
			await page.evaluate(() => {
				const scroller = document.querySelector('.overflow-auto') as HTMLElement | null
				if (!scroller) return
				const scrollerRect = scroller.getBoundingClientRect()
				const rows = Array.from(scroller.querySelectorAll('[data-drag-row]'))
				for (const row of rows) {
					const rect = row.getBoundingClientRect()
					if (rect.top > scrollerRect.top + 20) {
						;(row as HTMLElement).click()
						return
					}
				}
			})
			await expect(page).toHaveURL(/\/objects\//, { timeout: 10_000 })
			await page.goBack()

			await expect(page.getByText(/Scroll Anchor Row \d+/).first()).toBeVisible({
				timeout: 10_000,
			})

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
