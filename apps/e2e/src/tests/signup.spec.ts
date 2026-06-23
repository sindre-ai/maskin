import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const TEST_PASSWORD = 'e2e-test-password-123'

test.describe('Signup', () => {
	test('can create an account and be redirected to workspace', async ({ page }) => {
		await page.goto('/signup')

		await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()

		await page.getByPlaceholder('Your name').fill('E2E Signup Test')
		await page.getByPlaceholder('Company or team').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill(`signup-${Date.now()}@test.invalid`)
		await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD)
		await page.getByPlaceholder('Repeat your password').fill(TEST_PASSWORD)
		await page.getByRole('button', { name: 'Create account' }).click()

		// After signup, should be redirected to the authenticated area
		await expect(page).not.toHaveURL('/signup', { timeout: 10000 })
	})

	test('shows error when name is empty', async ({ page }) => {
		await page.goto('/signup')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Name is required')).toBeVisible()
	})

	test('shows error when organization is empty', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Organization is required')).toBeVisible()
	})

	test('shows error when role is empty', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByPlaceholder('Company or team').fill('Test Co')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Role is required')).toBeVisible()
	})

	test('shows error when password is too short', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByPlaceholder('Company or team').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill('test@test.invalid')
		await page.getByPlaceholder('At least 8 characters').fill('short')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()
	})

	test('shows error when passwords do not match', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByPlaceholder('Company or team').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill('test@test.invalid')
		await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD)
		await page.getByPlaceholder('Repeat your password').fill('different-password')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Passwords do not match')).toBeVisible()
	})

	test('has link to login page', async ({ page }) => {
		await page.goto('/signup')
		await page.getByRole('link', { name: 'Sign in' }).click()

		await expect(page).toHaveURL('/login')
	})

	test.describe('responsive — new fields visible at ship-gate viewports', () => {
		for (const vp of SHIP_GATE_VIEWPORTS) {
			test(`renders Organization and Role fields at ${vp.label}`, async ({ page }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.goto('/signup')

				await expect(page.getByPlaceholder('Your name')).toBeVisible()
				await expect(page.getByPlaceholder('Company or team')).toBeVisible()
				await expect(page.getByPlaceholder('What you do')).toBeVisible()
				await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
				await expect(page.getByPlaceholder('At least 8 characters')).toBeVisible()
				await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
			})
		}
	})
})
