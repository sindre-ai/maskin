import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const TITLE = 'Object header subscribe affordance'

test.describe('Object detail header — one-tap subscribe', () => {
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

			// The properties sidebar mounts its own SubscribeToggle with the same
			// aria-labels, and it is on screen from iPad up — scope to the header.
			const header = page.locator('[data-object-detail-header]')
			const unsubscribe = header.getByRole('button', { name: /unsubscribe from this object/i })
			const subscribe = header.getByRole('button', { name: /^subscribe to this object/i })

			// The backend auto-subscribes the creator on create, so the header opens
			// in the subscribed state: the current actor's avatar is the unsubscribe
			// control and the dedicated "+" subscribe button is absent.
			await expect(unsubscribe).toBeVisible({ timeout: 15000 })
			await expect(subscribe).toHaveCount(0)

			await unsubscribe.click()
			await expect(subscribe).toBeVisible({ timeout: 15000 })
			await expect(unsubscribe).toHaveCount(0)

			// State persists across reload — the server owns `is_subscribed`.
			await page.reload()
			await expect(subscribe).toBeVisible({ timeout: 15000 })

			// And back again: subscribing restores the avatar/unsubscribe control.
			await subscribe.click()
			await expect(unsubscribe).toBeVisible({ timeout: 15000 })
		})
	}
})
