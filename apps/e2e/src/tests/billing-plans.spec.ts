import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

// The app's theme defaults to 'light' (not 'system'), so page.emulateMedia
// alone has no effect — the FOUC script in index.html reads localStorage
// 'maskin-theme' before first paint. Set it explicitly via addInitScript so
// dark mode actually renders. See apps/e2e/src/tests/visual.spec.ts.
async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function mockUsage(
	page: Page,
	usage: {
		plan: 'trial' | 'pro' | 'team' | 'byollm'
		status: 'active' | 'past_due' | 'canceled' | 'incomplete'
		tokens_used: number
		hard_cap_tokens: number | null
		period_resets_in_ms: number | null
	},
) {
	await page.route('**/api/billing/usage*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				period_start: null,
				stripe_customer_id: null,
				stripe_subscription_id: null,
				...usage,
			}),
		})
	})
}

test.describe('Billing plans — Settings UI', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders usage banner and upgrade CTAs for a fresh trial account — ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/settings/keys`)

			await expect(page.getByText('Trial')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Upgrade to Team' })).toBeVisible()
		})
	}

	test('Hide plans / Compare plans toggles the plan comparison grid', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/settings/keys`)

		// Trial (non paid+active) starts with the comparison grid expanded.
		await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible()
		await page.getByRole('button', { name: 'Hide plans' }).click()
		await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).not.toBeVisible()

		await page.getByRole('button', { name: 'Compare plans' }).click()
		await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible()
	})

	test('upgrade click redirects to the mocked Stripe checkout url', async ({ page, account }) => {
		const mockCheckoutUrl = `${BASE}/${account.workspaceId}/settings/keys?billing=mock-checkout`
		await page.route('**/api/billing/checkout', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ url: mockCheckoutUrl, session_id: 'cs_test_mock' }),
			})
		})

		await page.goto(`/${account.workspaceId}/settings/keys`)
		await page.getByRole('button', { name: 'Upgrade to Pro' }).click()

		await page.waitForURL((url) => url.toString().includes('billing=mock-checkout'))
	})

	test('usage banner switches to warning tokens in a near-cap/past_due state, in both light and dark mode', async ({
		page,
		account,
	}) => {
		await mockUsage(page, {
			plan: 'pro',
			status: 'past_due',
			tokens_used: 30_000_000,
			hard_cap_tokens: 32_000_000,
			period_resets_in_ms: 5 * 24 * 60 * 60 * 1000,
		})

		const borderColors: Record<'light' | 'dark', string> = { light: '', dark: '' }

		for (const theme of ['light', 'dark'] as const) {
			await setTheme(page, theme)
			await page.goto(`/${account.workspaceId}/settings/keys`)

			await expect(page.getByText('Past due')).toBeVisible()

			const banner = page.getByTestId('usage-banner')
			await expect(banner).toBeVisible()
			borderColors[theme] = await banner.evaluate((el) => getComputedStyle(el).borderColor)
			// Warning-state banner is never fully transparent / neutral.
			expect(borderColors[theme]).not.toBe('')
			expect(borderColors[theme]).not.toMatch(/rgba\(0, 0, 0, 0\)/)
		}

		// --warning differs between light (#d97706) and dark (#f59e0b) — the
		// rendered border color must follow, proving the token (not a hardcoded
		// value) drives the warning state in both modes.
		expect(borderColors.light).not.toBe(borderColors.dark)
	})
})
