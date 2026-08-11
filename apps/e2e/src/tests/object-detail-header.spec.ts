import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 gate — verifies the object-detail static shell's identity row at each
// ship-gate viewport (375 / 768 / 1024): type tag + status picker (with the
// checked-option indicator) + driver picker above a static <h1>, the
// [data-hero-status-trigger] anchor preserved for the sticky nav, no inline
// SubscribeToggle / creator / timestamp chips in the row, and no horizontal
// page scroll at any viewport.

const HEADER_TITLE = 'T1 static shell header'

test.describe('Object detail — above-title identity row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders identity row above static <h1> at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: HEADER_TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const title = page.getByRole('heading', { level: 1, name: HEADER_TITLE })
			await expect(title).toBeVisible({ timeout: 15000 })

			// The identity row is the sticky-nav anchor: it hosts the
			// [data-hero-status-trigger] element (the StatusSelect trigger).
			const statusTrigger = page.locator('[data-hero-status-trigger]')
			await expect(statusTrigger).toBeVisible()

			// DOM order: the identity row (via the status trigger) must appear
			// before the static <h1> title in the DOM.
			const order = await page.evaluate(() => {
				const trigger = document.querySelector('[data-hero-status-trigger]')
				const heading = document.querySelector('h1')
				if (!trigger || !heading) return null
				// DOCUMENT_POSITION_FOLLOWING = 4 — bit set when the heading
				// follows the trigger in source order.
				const relation = trigger.compareDocumentPosition(heading)
				return {
					triggerBeforeTitle: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				}
			})
			expect(order?.triggerBeforeTitle).toBe(true)

			// Status dropdown exposes the checked-option indicator: opening the
			// picker marks the current status with data-state="checked".
			await statusTrigger.click()
			const checkedOption = page.getByRole('option', { name: 'active' })
			await expect(checkedOption).toHaveAttribute('data-state', 'checked')
			await page.keyboard.press('Escape')

			// Type badge + driver picker. OwnerSelect wraps a Radix SelectTrigger
			// (role="combobox"); ARIA disallows name-from-content for combobox,
			// so locate it via its visible "Unassigned" value (compact mode).
			await expect(page.getByText('bet', { exact: true }).first()).toBeVisible()
			await expect(
				page
					.getByRole('combobox')
					.filter({ hasText: /unassigned/i })
					.first(),
			).toBeVisible()

			// No inline SubscribeToggle / creator / created-updated chips render
			// in the identity row. Scoped to the row itself via the status-trigger
			// ancestor — the composer below legitimately renders <time>-free text
			// and the overflow menu lives elsewhere.
			const identityRow = page
				.locator('[data-hero-status-trigger]')
				.locator('xpath=ancestor::div[contains(@class, "flex-wrap")][1]')
			await expect(identityRow.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			const heroTimes = await identityRow.locator('xpath=.//time').count()
			expect(heroTimes).toBe(0)

			// Fold check: the <h1> must still be inside the viewport at this
			// ship-gate viewport (the identity row must not wrap deep enough to
			// push the title below the fold).
			const titleBox = await title.boundingBox()
			expect(titleBox).not.toBeNull()
			if (titleBox) {
				expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
			}

			// No horizontal page scroll at any ship-gate viewport.
			const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
			expect(scrollWidth).toBeLessThanOrEqual(vp.width)
		})
	}
})
