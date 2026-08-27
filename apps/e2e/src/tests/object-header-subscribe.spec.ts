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

			// The backend auto-subscribes the creator on create, so the header opens
			// in the subscribed state: the current actor's avatar is the unsubscribe
			// control and the dedicated "+" subscribe button is absent.
			const unsubscribe = page.getByRole('button', { name: /unsubscribe from this object/i })
			const subscribe = page.getByRole('button', { name: /^subscribe to this object/i })

			await expect(unsubscribe).toBeVisible({ timeout: 15000 })
			await expect(subscribe).toHaveCount(0)

			await unsubscribe.click()
			await expect(subscribe).toBeVisible({ timeout: 15000 })

			// State persists across reload — the server owns `is_subscribed`.
			await page.reload()
			await expect(page.getByRole('button', { name: /^subscribe to this object/i })).toBeVisible({
				timeout: 15000,
			})

			// And back again: subscribing restores the avatar/unsubscribe control.
			await page.getByRole('button', { name: /^subscribe to this object/i }).click()
			await expect(page.getByRole('button', { name: /unsubscribe from this object/i })).toBeVisible(
				{ timeout: 15000 },
			)
		})
	}
})
