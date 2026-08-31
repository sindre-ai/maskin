import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const TITLE = 'Object subscribe affordance'

// Subscription used to be a one-tap toggle in the object detail header. The v2
// detail bar carries only the drawer toggle and the ⋯ menu, so the affordance
// now lives in the properties drawer's Subscribed section (mockup 1445), which
// also lists who gets timeline updates. The contract this pins is unchanged:
// one control, it round-trips, and the server owns `is_subscribed`.
test.describe('Object properties drawer — subscribe', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`subscribe / unsubscribe round-trips at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 15000,
			})

			// Open the drawer from the detail bar's toggle, scoped to the bar — the
			// drawer body and the files table carry their own "…properties" controls.
			// Gate on the section itself rather than the toggle's aria-expanded:
			// below 768 the drawer is a modal Sheet that puts the bar behind
			// `aria-hidden`, so the toggle is unreadable while it is open.
			const subscribedSection = page.getByText('Subscribed', { exact: true })
			// At and above 768 the drawer is an offcanvas panel: it keeps its
			// content mounted and merely translates it out of the page, so
			// `isVisible()` reports true while it is shut and the section's
			// controls sit outside the viewport where they cannot be clicked.
			// Whether it is really open is a question about geometry, not
			// visibility, so gate on the box.
			const sectionOnScreen = async () => {
				const box = await subscribedSection.boundingBox().catch(() => null)
				const vp = page.viewportSize()
				if (!box || !vp) return false
				return box.x >= 0 && box.x < vp.width && box.y < vp.height && box.y + box.height > 0
			}
			const openDrawer = async () => {
				if (await sectionOnScreen()) return
				await page
					.locator('main header')
					.first()
					.getByRole('button', { name: 'Properties', exact: true })
					.click()
				await expect(subscribedSection).toBeInViewport({ timeout: 15000 })
			}
			await openDrawer()

			const unsubscribe = page.getByRole('button', { name: 'Unsubscribe', exact: true })
			const subscribe = page.getByRole('button', { name: 'Subscribe', exact: true })

			// The backend auto-subscribes the creator on create, so the drawer opens
			// offering the way out rather than the way in.
			await expect(unsubscribe).toBeVisible({ timeout: 15000 })
			await expect(subscribe).toHaveCount(0)

			await unsubscribe.click()
			await expect(subscribe).toBeVisible({ timeout: 15000 })
			await expect(unsubscribe).toHaveCount(0)

			// State persists across reload — the server owns `is_subscribed`.
			await page.reload()
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 15000,
			})
			await openDrawer()
			await expect(subscribe).toBeVisible({ timeout: 15000 })

			// And back again.
			await subscribe.click()
			await expect(unsubscribe).toBeVisible({ timeout: 15000 })
		})
	}
})
