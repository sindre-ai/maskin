import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Billing settings surface (T1).
 *
 * In the E2E environment STRIPE_SECRET_KEY is unset, so the backend reports
 * `configured: false` and the page renders the free-plan defaults with the
 * "Stripe is not configured" notice and a disabled Change plan button. These
 * specs assert that graceful unconfigured fallback, the "Payment, details and
 * invoices" disclosure (mockup 2883-2946) opening and closing, and the
 * empty-invoices state at every ship-gate viewport, plus light/dark theme.
 *
 * A fixture workspace has run no agent sessions, so the model-usage block
 * (mockup 2803-2813) renders its no-usage line and the usage-details
 * disclosure (2841-2858) its empty explanation — both driven by
 * GET /api/sessions/usage, never by a placeholder figure.
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

			// The plan banner names the plan and its state.
			await expect(page.getByRole('heading', { name: 'Free' }).first()).toBeVisible()

			// Unconfigured instance: free plan, no subscription yet.
			await expect(page.getByText('No active subscription').first()).toBeVisible()

			// Change plan is disabled until Stripe is configured.
			await expect(page.getByRole('button', { name: 'Change plan' }).first()).toBeDisabled()

			// With zero invoices the payment disclosure starts collapsed — its
			// contents must not be on the page until the trigger is used.
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toHaveCount(0)
			await expect(page.getByText('No invoices yet')).toHaveCount(0)

			// Opening the disclosure reveals payment method, billing details and invoices.
			await page.getByRole('button', { name: /Payment, details and invoices/ }).click()
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'BILLING DETAILS' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'INVOICES' })).toBeVisible()
			await expect(page.getByText('Not set').first()).toBeVisible()
			await expect(page.getByText('No invoices yet').first()).toBeVisible()

			// …and closing it hides them again.
			await page.getByRole('button', { name: /Payment, details and invoices/ }).click()
			await expect(page.getByRole('heading', { name: 'PAYMENT METHOD' })).toHaveCount(0)
		})

		test(`renders the model-usage block and usage details at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openBillingPage(page, account.workspaceId)

			// Usage block: a fresh workspace has no session cost, so it says so
			// rather than rendering a $0.00 that looks like a real bill.
			await expect(page.getByText('No model usage recorded this month yet.')).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText(/resets/).first()).toBeVisible()

			// Usage details start collapsed and open on click.
			await expect(page.getByText(/No agent has finished a session this month/)).toHaveCount(0)
			await page.getByRole('button', { name: /Usage details/ }).click()
			await expect(page.getByText(/No agent has finished a session this month/)).toBeVisible()
			await page.getByRole('button', { name: /Usage details/ }).click()
			await expect(page.getByText(/No agent has finished a session this month/)).toHaveCount(0)

			// The page itself must never scroll sideways at any ship-gate width.
			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflows).toBe(false)
		})

		test(`renders the payment method and billing detail rows at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openBillingPage(page, account.workspaceId)

			await page.getByRole('button', { name: /Payment, details and invoices/ }).click()

			// No payment has ever succeeded here, so the card-present state must
			// not be claimed (mockup 2894-2905).
			await expect(page.getByText(/No card on file/)).toBeVisible()
			await expect(page.getByText(/A card is on file with Stripe/)).toHaveCount(0)

			// Billing details is a row list, one row per field the API returns
			// (mockup 2911-2916). No next-charge row without a next charge date.
			await expect(page.getByText('Billing email')).toBeVisible()
			await expect(page.getByText('Plan', { exact: true })).toBeVisible()
			await expect(page.getByText('Next charge')).toHaveCount(0)
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

			await expect(page.getByRole('heading', { name: 'Free' }).first()).toBeVisible()
			await page.getByRole('button', { name: /Payment, details and invoices/ }).click()
			await expect(page.getByText('No invoices yet').first()).toBeVisible()
		}
	})
})
