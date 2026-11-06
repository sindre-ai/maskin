import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const TEST_PASSWORD = 'e2e-test-password-123'

test.describe('Signup', () => {
	test('can create an account and be redirected to workspace', async ({ page }) => {
		await page.goto('/signup')

		await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()

		await page.getByPlaceholder('Your name').fill('E2E Signup Test')
		await page.getByPlaceholder('Company name').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill(`signup-${Date.now()}@test.invalid`)
		await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD)
		await page.getByPlaceholder('Repeat your password').fill(TEST_PASSWORD)
		await page.getByRole('button', { name: 'Create account' }).click()

		// After signup, should be redirected to the authenticated area
		await expect(page).not.toHaveURL('/signup', { timeout: 10000 })
	})

	test('lands back on the page that sent the person here after signing up', async ({ page }) => {
		// A realistic authorize-style path: about 900 characters, well under the 2000 cap
		// that safeInternalPath enforces. The route does not exist yet; only the landing URL matters.
		const target = `/e2e-return-path?client_id=${'c'.repeat(55)}&state=${'s'.repeat(512)}&code_challenge=${'k'.repeat(43)}&resource=${encodeURIComponent('http://localhost:5173/mcp')}&pad=${'x'.repeat(150)}`
		expect(target.length).toBeGreaterThan(800)
		expect(target.length).toBeLessThan(2000)

		await page.goto(`/signup?redirect=${encodeURIComponent(target)}`)
		await page.getByPlaceholder('Your name').fill('E2E Return Path')
		await page.getByPlaceholder('Company name').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill(`return-path-${Date.now()}@test.invalid`)
		await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD)
		await page.getByPlaceholder('Repeat your password').fill(TEST_PASSWORD)
		await page.getByRole('button', { name: 'Create account' }).click()

		await page.waitForURL((url) => url.pathname + url.search === target, { timeout: 10000 })
	})

	test('ignores an off-site redirect value and lands on the app root', async ({ page }) => {
		await page.goto(`/signup?redirect=${encodeURIComponent('https://evil.example/steal')}`)
		await page.getByPlaceholder('Your name').fill('E2E Off Site')
		await page.getByPlaceholder('Company name').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill(`off-site-${Date.now()}@test.invalid`)
		await page.getByPlaceholder('At least 8 characters').fill(TEST_PASSWORD)
		await page.getByPlaceholder('Repeat your password').fill(TEST_PASSWORD)
		await page.getByRole('button', { name: 'Create account' }).click()

		await page.waitForURL((url) => url.pathname !== '/signup', { timeout: 10000 })
		expect(new URL(page.url()).hostname).toBe('localhost')
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
		await page.getByPlaceholder('Company name').fill('Test Co')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Role is required')).toBeVisible()
	})

	test('shows error when password is too short', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByPlaceholder('Company name').fill('Test Co')
		await page.getByPlaceholder('What you do').fill('Founder')
		await page.getByPlaceholder('you@example.com').fill('test@test.invalid')
		await page.getByPlaceholder('At least 8 characters').fill('short')
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()
	})

	test('shows error when passwords do not match', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Test User')
		await page.getByPlaceholder('Company name').fill('Test Co')
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
				await expect(page.getByPlaceholder('Company name')).toBeVisible()
				await expect(page.getByPlaceholder('What you do')).toBeVisible()
				await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
				await expect(page.getByPlaceholder('At least 8 characters')).toBeVisible()
				await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
			})
		}
	})
})
