import { expect, test } from '@playwright/test'
import { createTestActor } from '../helpers/api.helper'

test.describe('Login', () => {
	test('can log in with a valid API key', async ({ page }) => {
		const actor = await createTestActor({
			name: `E2E Login ${Date.now()}`,
			email: `login-${Date.now()}@test.com`,
		})

		await page.goto('/login')

		await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

		await page.getByPlaceholder('ank_...').fill(actor.api_key)
		await page.getByRole('button', { name: 'Sign in' }).click()

		// Should redirect away from login
		await expect(page).not.toHaveURL('/login', { timeout: 10000 })
	})

	test('shows error when API key is empty', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('button', { name: 'Sign in' }).click()

		await expect(page.getByText('API key is required')).toBeVisible()
	})

	test('has link to signup page', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('link', { name: 'Sign up' }).click()

		await expect(page).toHaveURL('/signup')
	})
})
