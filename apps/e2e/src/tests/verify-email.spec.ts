import { expect, test } from '../fixtures/auth.fixture'
import { getPendingEmailToken } from '../helpers/db.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const TEST_PASSWORD = 'e2e-test-password-123'

test.describe('Verify email', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows success state and changes the account email at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const newEmail = `verify-email-success-${vp.width}-${Date.now()}@test.invalid`
			await account.api.requestEmailChange({
				current_password: TEST_PASSWORD,
				new_email: newEmail,
			})

			// Real token minted by the backend, read straight from Postgres — the
			// API response never includes it (it proves ownership of the new address).
			const token = await getPendingEmailToken(account.actorId)

			await page.goto(`/verify-email?token=${token}`)

			// Must land on the success state, not hang on the spinner.
			await expect(page.getByText('Verifying your email…')).not.toBeVisible()
			await expect(page.getByText('Email updated')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText(`Your account email is now ${newEmail}.`)).toBeVisible()

			// The email change actually happened server-side.
			const actor = await account.api.getActor(account.actorId)
			expect(actor.email).toBe(newEmail)
		})
	}

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows verification-failed state for an invalid token at ${vp.label}`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await page.goto('/verify-email?token=this-token-does-not-exist')

			// Must land on the error state, not hang on the spinner.
			await expect(page.getByText('Verifying your email…')).not.toBeVisible()
			await expect(page.getByText('Verification failed')).toBeVisible({ timeout: 10000 })
		})
	}
})
