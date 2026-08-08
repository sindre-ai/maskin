import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// "Continue with vaerksted" (vaerksted-auth-and-sync.md §8, implementation
// plan M5) on the login/signup pages. Per .claude/rules/verification.md this
// spec proves the button renders, is reachable/visible at the three
// ship-gate viewports in both color schemes, and is wired to actually start
// the flow when clicked — NOT a full login round trip. A real Supabase
// magic-link/OAuth flow needs live vaerksted-auth credentials
// (VITE_VAERKSTED_SUPABASE_URL/ANON_KEY, VITE_VAERKSTED_AUTH_BASE_URL) that
// don't exist in this test environment, so clicking the button deterministically
// surfaces "vaerksted sign-in is not configured" here — that error only
// appears if the button's onClick handler actually ran the real
// useVaerkstedAuth().sendMagicLink() code path (apps/web/src/hooks/use-vaerksted-auth.ts),
// which is exactly the "wired to start the flow" property this spec pins.

for (const vp of SHIP_GATE_VIEWPORTS) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`Continue with vaerksted button — ${vp.label}, ${colorScheme} mode`, () => {
			test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme })

			test('is visible on the login page', async ({ page }) => {
				await page.goto('/login')
				const button = page.getByRole('button', { name: 'Continue with vaerksted' })
				await expect(button).toBeVisible()
			})

			test('is visible on the signup page', async ({ page }) => {
				await page.goto('/signup')
				const button = page.getByRole('button', { name: 'Continue with vaerksted' })
				await expect(button).toBeVisible()
			})
		})
	}
}

test.describe('Continue with vaerksted — interaction', () => {
	test('requires an email before starting the flow', async ({ page }) => {
		await page.goto('/login')
		await page.getByRole('button', { name: 'Continue with vaerksted' }).click()
		await expect(
			page.getByText('Enter your email above, then continue with vaerksted'),
		).toBeVisible()
	})

	test('attempts to start the flow once an email is present', async ({ page }) => {
		await page.goto('/login')
		await page.getByPlaceholder('you@example.com').fill('vaerksted-e2e@test.invalid')
		await page.getByRole('button', { name: 'Continue with vaerksted' }).click()

		// This environment has no live vaerksted-auth Supabase credentials
		// configured, so the flow cannot complete — but reaching this specific
		// error proves the click was wired to the real sign-in code path
		// (useVaerkstedAuth().sendMagicLink), not a dead button.
		await expect(page.getByText('vaerksted sign-in is not configured')).toBeVisible()
	})

	test('same flow is wired on the signup page', async ({ page }) => {
		await page.goto('/signup')
		await page.getByPlaceholder('you@example.com').fill('vaerksted-e2e-signup@test.invalid')
		await page.getByRole('button', { name: 'Continue with vaerksted' }).click()
		await expect(page.getByText('vaerksted sign-in is not configured')).toBeVisible()
	})
})
