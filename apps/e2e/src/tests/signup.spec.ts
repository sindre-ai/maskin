import { expect, test } from '@playwright/test'

test.describe('Signup', () => {
	test('can create an account and receive an API key', async ({ page }) => {
		let dialogMessage = ''
		page.on('dialog', async (dialog) => {
			dialogMessage = dialog.message()
			await dialog.accept()
		})

		await page.goto('/signup')

		await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()

		await page.getByPlaceholder('Your name').fill('E2E Signup Test')
		await page.getByPlaceholder('you@example.com').fill(`signup-${Date.now()}@test.com`)
		await page.getByRole('button', { name: 'Create account' }).click()

		// The app shows an alert with the API key, then navigates to workspace
		await expect(() => {
			expect(dialogMessage).toContain('ank_')
		}).toPass({ timeout: 10000 })

		// After signup, should be redirected to the authenticated area
		await expect(page).not.toHaveURL('/signup', { timeout: 10000 })
	})

	test('shows error when name is empty', async ({ page }) => {
		await page.goto('/signup')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Name is required')).toBeVisible()
	})

	test('has link to login page', async ({ page }) => {
		await page.goto('/signup')
		await page.getByRole('link', { name: 'Sign in' }).click()

		await expect(page).toHaveURL('/login')
	})
})
