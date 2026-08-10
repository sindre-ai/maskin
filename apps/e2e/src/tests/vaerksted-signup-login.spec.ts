import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// vaerksted-auth-and-sync.md §8, implementation plan M5 — native password
// auth was removed from apps/web entirely; /login and /signup are now
// vaerksted-only (magic-link), with /signup collecting name/organization/
// role inline before the link is sent (no post-redirect popup). Per
// .claude/rules/verification.md this spec proves both pages render at the
// three ship-gate viewports in both color schemes, have no leftover password
// fields, and are wired to actually start the real sign-in flow when
// submitted — NOT a full login round trip. This test environment has no
// live vaerksted-auth Supabase credentials (VITE_VAERKSTED_SUPABASE_URL/
// ANON_KEY, VITE_VAERKSTED_AUTH_BASE_URL), so submitting deterministically
// surfaces "vaerksted sign-in is not configured" — that error only appears
// if the submit handler actually ran the real
// useVaerkstedAuth().sendMagicLink() code path
// (apps/web/src/hooks/use-vaerksted-auth.ts), which is exactly the
// "wired to the real flow" property this spec pins.

for (const vp of SHIP_GATE_VIEWPORTS) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`vaerksted-only auth pages — ${vp.label}, ${colorScheme} mode`, () => {
			test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme })

			test('login page has no password field, only email + Sign in', async ({ page }) => {
				await page.goto('/login')
				await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
				await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
				await expect(page.getByPlaceholder('Your password')).toHaveCount(0)
			})

			test('signup page has no password fields, only name/organization/role/email + Create account', async ({
				page,
			}) => {
				await page.goto('/signup')
				await expect(page.getByPlaceholder('Your name')).toBeVisible()
				await expect(page.getByPlaceholder('Company name')).toBeVisible()
				await expect(page.getByPlaceholder('What you do')).toBeVisible()
				await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
				await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
				await expect(page.getByPlaceholder('At least 8 characters')).toHaveCount(0)
				await expect(page.getByPlaceholder('Repeat your password')).toHaveCount(0)
			})
		})
	}
}

test.describe('vaerksted-only auth — interaction', () => {
	test('login requires an email before starting the flow', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('button', { name: 'Sign in' }).click()
		await expect(page.getByText('Email is required')).toBeVisible()
	})

	test('login attempts to start the real sign-in flow once an email is present', async ({
		page,
	}) => {
		await page.goto('/login')
		await page.getByPlaceholder('you@example.com').fill('vaerksted-e2e@test.invalid')
		await page.getByRole('button', { name: 'Sign in' }).click()
		await expect(page.getByText('vaerksted sign-in is not configured')).toBeVisible()
	})

	test('signup validates name/organization/role/email before starting the flow', async ({
		page,
	}) => {
		await page.goto('/signup')
		await page.getByRole('button', { name: 'Create account' }).click()
		await expect(page.getByText('Name is required')).toBeVisible()

		await page.getByPlaceholder('Your name').fill('Ada Lovelace')
		await page.getByRole('button', { name: 'Create account' }).click()
		await expect(page.getByText('Organization is required')).toBeVisible()

		await page.getByPlaceholder('Company name').fill('Analytical Engines Inc')
		await page.getByRole('button', { name: 'Create account' }).click()
		await expect(page.getByText('Role is required')).toBeVisible()
	})

	test('signup attempts to start the real sign-in flow once all fields are present', async ({
		page,
	}) => {
		await page.goto('/signup')
		await page.getByPlaceholder('Your name').fill('Ada Lovelace')
		await page.getByPlaceholder('Company name').fill('Analytical Engines Inc')
		await page.getByPlaceholder('What you do').fill('Mathematician')
		await page.getByPlaceholder('you@example.com').fill('vaerksted-e2e-signup@test.invalid')
		await page.getByRole('button', { name: 'Create account' }).click()
		await expect(page.getByText('vaerksted sign-in is not configured')).toBeVisible()
	})

	test('login page has a link to signup', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('link', { name: 'Sign up' }).click()
		await expect(page).toHaveURL('/signup')
	})

	test('signup page has a link to login', async ({ page }) => {
		await page.goto('/signup')
		await page.getByRole('link', { name: 'Sign in' }).click()
		await expect(page).toHaveURL('/login')
	})
})
