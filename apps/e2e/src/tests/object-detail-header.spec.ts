import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 shell gate — verifies the object-detail hero renders above a static
// <h1> at each ship-gate viewport (375 / 768 / 1024): breadcrumb with a
// back-to-Objects link, identity row (type tag, status trigger, driver
// picker) above the title, overflow menu, and no horizontal scroll. The
// identity row still hosts [data-hero-status-trigger] so the sticky-nav
// chip can smooth-scroll here and focus the picker.

const HEADER_TITLE = 'T1 static shell header'

test.describe('Object detail — above-title hero (static shell)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders hero above static <h1> at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: HEADER_TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			// The title is a static heading — the edit-in-place textarea is
			// gone (superseded by the static shell).
			const title = page.getByRole('heading', { level: 1, name: HEADER_TITLE })
			await expect(title).toBeVisible({ timeout: 15000 })
			await expect(page.getByPlaceholder('Untitled')).toHaveCount(0)

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
				// DOCUMENT_POSITION_FOLLOWING = 4 — bit set when heading follows
				// the trigger in source order.
				const relation = trigger.compareDocumentPosition(heading)
				return {
					triggerBeforeTitle: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				}
			})
			expect(order?.triggerBeforeTitle).toBe(true)

			// Fold check: the <h1> must still be inside the viewport at this
			// ship-gate viewport (bet exit criterion — the identity row must
			// not wrap into a stack tall enough to push the title below the
			// fold).
			const titleBox = await title.boundingBox()
			expect(titleBox).not.toBeNull()
			if (titleBox) {
				expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
			}

			// The identity elements the DoD names: TypeBadge, status control,
			// OwnerSelect — all present and visible in the row. OwnerSelect
			// wraps a Radix SelectTrigger (role="combobox") which has no
			// aria-label; locate it via its visible "Driver:" prefix.
			await expect(page.getByText('bet', { exact: true }).first()).toBeVisible()
			await expect(
				page
					.getByRole('combobox')
					.filter({ hasText: /driver/i })
					.first(),
			).toBeVisible()

			// Breadcrumb: the Objects crumb is a link back to the list. At ≥768px
			// the sidebar nav and the app-bar breadcrumb also render an "Objects"
			// link, so scope to the shell breadcrumb (the one containing the
			// current-title crumb) to keep the lookup single-match.
			const shellBreadcrumb = page
				.getByRole('navigation', { name: 'breadcrumb' })
				.filter({ has: page.getByRole('link', { name: HEADER_TITLE }) })
			await expect(shellBreadcrumb.getByRole('link', { name: 'Objects' })).toBeVisible()

			// Overflow menu hosts the actions (Archive + Delete for bets).
			const overflow = page.getByRole('button', { name: /more actions/i })
			await expect(overflow).toBeVisible()

			// No horizontal scroll at this ship-gate viewport.
			const scrollWidth = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(scrollWidth).toBeLessThanOrEqual(0)

			// SubscribeToggle + creator + created/updated timestamps must no
			// longer render inline in the identity row; scoped to the row itself
			// (via the status-trigger ancestor) since the ⋯ menu's Subscribe
			// action is a menuitem, not a row-level button.
			const identityRow = page
				.locator('[data-hero-status-trigger]')
				.locator('xpath=ancestor::div[contains(@class, "flex-wrap")][1]')
			await expect(identityRow.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			const heroTimes = await identityRow.locator('xpath=.//time').count()
			expect(heroTimes).toBe(0)
		})
	}
})
