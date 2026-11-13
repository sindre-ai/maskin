import { expect, test } from '@playwright/test'
import { createTestActor } from '../helpers/api.helper'
import { countSentEmails, waitForPasswordResetLink } from '../helpers/mock-resend.helper'

const OLD_PASSWORD = 'e2e-old-password-123'
const NEW_PASSWORD = 'e2e-new-password-456'
const SENT_MESSAGE = 'If that email has an account, we sent a link.'

test.describe('Forgot password', () => {
	test('resets by email link, then signs in with the new password only', async ({ page }) => {
		const email = `reset-${Date.now()}@test.invalid`
		await createTestActor({ name: `E2E Reset ${Date.now()}`, email, password: OLD_PASSWORD })

		await page.goto('/login')
		await page.getByRole('link', { name: 'Forgot password?' }).click()
		await expect(page).toHaveURL(/\/forgot-password/)

		await page.getByPlaceholder('you@example.com').fill(email)
		await page.getByRole('button', { name: 'Send reset link' }).click()
		await expect(page.getByText(SENT_MESSAGE)).toBeVisible()

		const link = await waitForPasswordResetLink(email)
		await page.goto(link)
		await page.getByPlaceholder('At least 8 characters').fill(NEW_PASSWORD)
		await page.getByPlaceholder('Type it again').fill(NEW_PASSWORD)
		await page.getByRole('button', { name: 'Set new password' }).click()
		await expect(page).toHaveURL(/\/login/)

		// The old password no longer works.
		await page.getByPlaceholder('you@example.com').fill(email)
		await page.getByPlaceholder('Your password').fill(OLD_PASSWORD)
		await page.getByRole('button', { name: 'Sign in' }).click()
		await expect(page.getByText('Invalid credentials')).toBeVisible()

		// The new one does.
		await page.getByPlaceholder('Your password').fill(NEW_PASSWORD)
		await page.getByRole('button', { name: 'Sign in' }).click()
		await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 })

		// The link works once.
		await page.goto(link)
		await page.getByPlaceholder('At least 8 characters').fill('e2e-third-password-789')
		await page.getByPlaceholder('Type it again').fill('e2e-third-password-789')
		await page.getByRole('button', { name: 'Set new password' }).click()
		await expect(page.getByText('This reset link is invalid or has expired')).toBeVisible()
	})

	test('shows the same message for an unknown email and sends nothing', async ({ page }) => {
		const email = `nobody-${Date.now()}@test.invalid`

		await page.goto('/forgot-password')
		await page.getByPlaceholder('you@example.com').fill(email)
		await page.getByRole('button', { name: 'Send reset link' }).click()

		await expect(page.getByText(SENT_MESSAGE)).toBeVisible()
		await page.waitForTimeout(1000)
		expect(await countSentEmails(email)).toBe(0)
	})

	test('checks the new password before sending it', async ({ page }) => {
		await page.goto('/reset-password?token=rst_not-a-real-token')

		await page.getByPlaceholder('At least 8 characters').fill('short')
		await page.getByPlaceholder('Type it again').fill('short')
		await page.getByRole('button', { name: 'Set new password' }).click()
		await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()

		await page.getByPlaceholder('At least 8 characters').fill(NEW_PASSWORD)
		await page.getByPlaceholder('Type it again').fill('something-else-123')
		await page.getByRole('button', { name: 'Set new password' }).click()
		await expect(page.getByText('Passwords do not match')).toBeVisible()
	})
})
