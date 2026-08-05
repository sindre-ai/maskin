import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

<<<<<<< HEAD
// Object-detail hero — verifies the identity row above the <h1> renders only
// TypeBadge + driver (OwnerSelect) at each ship-gate viewport (375 / 768 /
// 1024). Status and the bet-status chip were moved to the properties
// sidebar and must NOT render in this row.
=======
// T2 gate — verifies the object-detail hero renders the identity row above
// the <h1> at each ship-gate viewport (375 / 768 / 1024) and that no inline
// SubscribeToggle / creator / created-at / updated-at chip renders in the
// header. Companion contract for the sticky-nav sprout-back: the identity
// row still hosts [data-hero-status-trigger] so the sticky chip can smooth-
// scroll here and focus the picker.
>>>>>>> ea24de97d56d89b3d4e7a60d535febc648d62fa1

const HEADER_TITLE = 'T2 header reorder'

test.describe('Object detail — above-title identity row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
<<<<<<< HEAD
		test(`renders TypeBadge + driver above <h1>, without status controls at ${vp.label}`, async ({
			page,
			account,
		}) => {
=======
		test(`renders identity row above <h1> at ${vp.label}`, async ({ page, account }) => {
>>>>>>> ea24de97d56d89b3d4e7a60d535febc648d62fa1
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: HEADER_TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const title = page.getByPlaceholder('Untitled')
			await expect(title).toHaveValue(HEADER_TITLE, { timeout: 15000 })

<<<<<<< HEAD
			const identityRow = page.getByTestId('object-identity-row')
			await expect(identityRow).toBeVisible()

			// DOM order: the identity row must appear before the <textarea> title.
			const order = await page.evaluate(() => {
				const row = document.querySelector('[data-testid="object-identity-row"]')
				const textarea = document.querySelector('textarea')
				if (!row || !textarea) return null
				const relation = row.compareDocumentPosition(textarea)
				return {
					rowBeforeTitle: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				}
			})
			expect(order?.rowBeforeTitle).toBe(true)

			// Fold check: the <h1> textarea must still be inside the viewport
			// at this ship-gate viewport.
=======
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
>>>>>>> ea24de97d56d89b3d4e7a60d535febc648d62fa1
			const titleBox = await title.boundingBox()
			expect(titleBox).not.toBeNull()
			if (titleBox) {
				expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
			}

<<<<<<< HEAD
			// TypeBadge + driver (OwnerSelect) — the only two elements the
			// identity row should show.
			await expect(identityRow.getByText('bet', { exact: true })).toBeVisible()
			await expect(identityRow.getByRole('combobox').filter({ hasText: /driver/i })).toBeVisible()

			// Status / dynamic-status controls must NOT render in the identity
			// row — the driver combobox should be the only combobox present.
			await expect(identityRow.getByRole('combobox')).toHaveCount(1)
			await expect(identityRow.getByText(/^active$/i)).toHaveCount(0)

			// SubscribeToggle + creator + created/updated timestamps must not
			// render inline in the identity row either.
			await expect(identityRow.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			await expect(identityRow.locator('time')).toHaveCount(0)
=======
			// The four identity elements the DoD names: TypeBadge, status
			// control, IndicatorBadgeChip, OwnerSelect — all present and
			// visible in the row. OwnerSelect wraps a Radix SelectTrigger
			// (role="combobox") which has no aria-label; ARIA disallows
			// name-from-content for combobox, so locate it via its visible
			// "Driver:" prefix instead.
			await expect(page.getByText('bet', { exact: true }).first()).toBeVisible()
			await expect(
				page
					.getByRole('combobox')
					.filter({ hasText: /driver/i })
					.first(),
			).toBeVisible()

			// SubscribeToggle + creator + created/updated timestamps must
			// no longer render inline in the identity row. Both checks are
			// scoped to the identity row itself (via the status-trigger
			// ancestor) — the page-wide Subscribe toggle in the properties
			// sidebar stays mounted off-screen (not display:none) at
			// tablet/desktop widths even when collapsed, so an unscoped
			// page-wide locator would false-positive on it. Activity below
			// the identity row also legitimately renders <time> for events,
			// so that check must stay scoped too.
			const identityRow = page
				.locator('[data-hero-status-trigger]')
				.locator('xpath=ancestor::div[contains(@class, "flex-wrap")][1]')
			await expect(identityRow.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			const heroTimes = await identityRow.locator('xpath=.//time').count()
			expect(heroTimes).toBe(0)
>>>>>>> ea24de97d56d89b3d4e7a60d535febc648d62fa1
		})
	}
})
