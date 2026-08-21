import { expect, test } from '@playwright/test'
import { createTestActor } from '../helpers/api.helper'
import { getSmokeConfig } from '../helpers/smoke'

const TEST_PASSWORD = 'e2e-test-password-123'

test.describe('Login', { tag: '@smoke' }, () => {
	test('can log in with email and password', async ({ page }) => {
		// Against a live deployment, sign-up would mint a real account on every
		// run, so the smoke tenant's existing credentials are used instead.
		const smoke = getSmokeConfig()
		let email: string
		let password: string

		if (smoke) {
			email = smoke.email
			password = smoke.password
		} else {
			email = `login-${Date.now()}@test.invalid`
			password = TEST_PASSWORD
			await createTestActor({ name: `E2E Login ${Date.now()}`, email, password })
		}

		await page.goto('/login')

		await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

		await page.getByPlaceholder('you@example.com').fill(email)
		await page.getByPlaceholder('Your password').fill(password)
		await page.getByRole('button', { name: 'Sign in' }).click()

		// Should redirect away from login
		await expect(page).not.toHaveURL('/login', { timeout: 10000 })
	})

	test('shows error when email is empty', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('button', { name: 'Sign in' }).click()

		await expect(page.getByText('Email is required')).toBeVisible()
	})

	test('shows error when password is empty', async ({ page }) => {
		await page.goto('/login')
		await page.getByPlaceholder('you@example.com').fill('someone@test.invalid')
		await page.getByRole('button', { name: 'Sign in' }).click()

		await expect(page.getByText('Password is required')).toBeVisible()
	})

	test('has link to signup page', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('link', { name: 'Sign up' }).click()

		await expect(page).toHaveURL('/signup')
	})
})
