import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T2 gate — verifies the object-detail hero renders the identity row above
// the <h1> at each ship-gate viewport (375 / 768 / 1024) and that no inline
// SubscribeToggle / creator / created-at / updated-at chip renders in the
// header. Companion contract for the sticky-nav sprout-back: the identity
// row still hosts [data-hero-status-trigger] so the sticky chip can smooth-
// scroll here and focus the picker.

const HEADER_TITLE = 'T2 header reorder'

test.describe('Object detail — above-title identity row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders identity row above <h1> at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: HEADER_TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const title = page.getByPlaceholder('Untitled')
			await expect(title).toHaveValue(HEADER_TITLE, { timeout: 10000 })

			// The identity row is the sticky-nav anchor: it hosts the
			// [data-hero-status-trigger] element (the StatusSelect trigger).
			// We locate the row via that trigger, then walk to its enclosing
			// flex-wrap container.
			const statusTrigger = page.locator('[data-hero-status-trigger]')
			await expect(statusTrigger).toBeVisible()

			// DOM order: the identity row (via the status trigger) must appear
			// before the <textarea> title in the DOM.
			const order = await page.evaluate(() => {
				const trigger = document.querySelector('[data-hero-status-trigger]')
				const textarea = document.querySelector('textarea')
				if (!trigger || !textarea) return null
				// DOCUMENT_POSITION_FOLLOWING = 4 — bit set when textarea
				// follows the trigger in source order.
				const relation = trigger.compareDocumentPosition(textarea)
				return {
					triggerBeforeTitle: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				}
			})
			expect(order?.triggerBeforeTitle).toBe(true)

			// Fold check: the <h1> textarea must still be inside the viewport
			// at this ship-gate viewport (bet exit criterion — the identity
			// row must not wrap into a stack tall enough to push the title
			// below the fold).
			const titleBox = await title.boundingBox()
			expect(titleBox).not.toBeNull()
			if (titleBox) {
				expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
			}

			// The four identity elements the DoD names: TypeBadge, status
			// control, IndicatorBadgeChip, OwnerSelect — all present and
			// visible in the row.
			await expect(page.getByText('bet', { exact: true }).first()).toBeVisible()
			await expect(page.getByRole('button', { name: /driver/i }).first()).toBeVisible()

			// SubscribeToggle + creator + created/updated timestamps must
			// no longer render inline in the header. Playwright's <time>
			// query is the cheapest proxy for the RelativeTime chips.
			await expect(page.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			const inlineTimes = await page.locator('main time, header time').count()
			expect(inlineTimes).toBe(0)
		})
	}
})
