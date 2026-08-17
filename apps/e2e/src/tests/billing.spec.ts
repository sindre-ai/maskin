import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Billing settings surface (T1).
 *
 * In the E2E environment STRIPE_SECRET_KEY is unset, so the backend reports
 * `configured: false` and the page renders the free-plan defaults with the
 * "Stripe is not configured" notice and a disabled Change plan button. These
 * specs assert that graceful unconfigured fallback (plus the empty-invoices
 * state) at every ship-gate viewport, and the light/dark theme surface.
 */

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function openBillingPage(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/billing`)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — Billing page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the billing cards and free-plan defaults at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openBillingPage(page, account.workspaceId)

			// Left rail (or horizontal chip strip on mobile) exposes Billing.
			await expect(page.getByRole('link', { name: 'Billing' }).first()).toBeVisible({
				timeout: 10000,
			})

			// The three cards render with their headings.
			await expect(page.getByRole('heading', { name: 'Current plan' }).first()).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Invoice email' }).first()).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Invoices' }).first()).toBeVisible()

			// Unconfigured instance: free plan, no subscription yet.
			await expect(page.getByText('No active subscription').first()).toBeVisible()
			await expect(page.getByText('Not set').first()).toBeVisible()

			// Change plan is disabled until Stripe is configured.
			await expect(page.getByRole('button', { name: 'Change plan' }).first()).toBeDisabled()

			// Invoices card shows the empty state rather than a blank table.
			await expect(page.getByText('No invoices yet').first()).toBeVisible()
		})

		test(`shows the Stripe not-configured notice at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openBillingPage(page, account.workspaceId)

			// Assert the positive side so a blank/crashed page can't pass vacuously.
			await expect(
				page.getByText('Stripe is not configured for this instance').first(),
			).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Manage on Stripe').first()).toBeDisabled()
		})
	}

	test('renders the billing surface in both light and dark mode', async ({ page, account }) => {
		for (const theme of ['light', 'dark'] as const) {
			await setTheme(page, theme)
			await page.setViewportSize(VIEWPORTS.mobile)
			await page.goto(`/${account.workspaceId}/settings/billing`)
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			if (theme === 'dark') {
				const isDark = await page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				)
				expect(isDark).toBe(true)
			}

			await expect(page.getByRole('heading', { name: 'Current plan' }).first()).toBeVisible()
			await expect(page.getByText('No invoices yet').first()).toBeVisible()
		}
	})
})
