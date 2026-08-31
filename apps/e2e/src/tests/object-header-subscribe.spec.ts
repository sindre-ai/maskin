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
			// CI serves the app from `vite dev`, so the first navigation of a shard
			// pays for on-demand compilation of the whole route graph — and this
			// file sorts first in its shard, which made its opening `goto` the one
			// that ate the cold start and timed out on a blank page. The extra
			// allowance is for the boot, not for anything this test does.
			test.slow()
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 45000,
			})

			// Open the drawer from the detail bar's toggle, scoped to the bar — the
			// drawer body and the files table carry their own "…properties" controls.
			const subscribedSection = page.getByText('Subscribed', { exact: true })
			// Whether the drawer is open cannot be read off its own content, in
			// either direction: at and above 768 it is an offcanvas panel that
			// keeps its content mounted and merely translates it away, so
			// `isVisible()` is true while it is shut; below 768 it is a modal
			// Sheet whose section can sit below the fold of its internal scroll,
			// so a viewport check calls an open drawer shut. Ask the toggle, which
			// carries `aria-expanded` — and note the Sheet puts the bar behind
			// `aria-hidden`, so the toggle being unreadable *is* the open state.
			const drawerToggle = page
				.locator('main header')
				.first()
				.getByRole('button', { name: 'Properties', exact: true })
			const openDrawer = async () => {
				if ((await drawerToggle.count()) === 0) return
				if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') return
				await drawerToggle.click()
				await expect(subscribedSection).toBeVisible({ timeout: 15000 })
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
