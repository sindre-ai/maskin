import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Usage as a percent of the plan, and the 100% screens, behind the trial-card-percent
// flag. The billing read is mocked so each state can be driven exactly; the stored cap
// is 286 cents (the 20 kr trial limit).
const CAP = 286

async function mockTrialUsage(page: Page, used: number, overrides: Record<string, unknown> = {}) {
	await page.route('**/api/billing/usage*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				plan: 'trial',
				status: 'active',
				usd_cents_used: used,
				hard_cap_usd_cents: CAP,
				period_start: null,
				period_resets_in_ms: 3 * 86_400_000,
				stripe_customer_id: null,
				stripe_subscription_id: null,
				credit_balance_cents: 0,
				credit_topup_available: false,
				linkedin_identity_addon: null,
				...overrides,
			}),
		})
	})
}

async function setFlag(page: Page, state: 'on' | 'off') {
	await page.addInitScript((s) => localStorage.setItem('ff:trial-card-percent', s), state)
}

test.describe('Plan usage as a percent', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`billing page headlines the percent with a meter and no dollars — ${vp.label}`, async ({
			page,
			account,
		}) => {
			await setFlag(page, 'on')
			await mockTrialUsage(page, 120)
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/settings/billing`)

			await expect(page.getByText('41%', { exact: true })).toBeVisible()
			await expect(page.getByText('of your plan used')).toBeVisible()
			await expect(page.getByRole('progressbar', { name: 'Plan usage' }).first()).toHaveAttribute(
				'aria-valuenow',
				'41',
			)
			await expect(page.getByTestId('usage-banner')).toContainText('41% of plan used')
			await expect(page.getByTestId('usage-banner')).not.toContainText('$')
		})

		test(`at 100% a banner opens the plan picker — ${vp.label}`, async ({ page, account }) => {
			await setFlag(page, 'on')
			await mockTrialUsage(page, CAP)
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/settings/billing`)

			const banner = page
				.getByRole('status')
				.filter({ hasText: 'You have used 100% of your trial' })
			await expect(banner).toBeVisible()
			await banner.getByRole('button', { name: 'Choose a plan' }).click()
			await expect(page.getByRole('dialog').getByText('Choose a plan').first()).toBeVisible()
		})
	}

	test('the warning line appears from 80%', async ({ page, account }) => {
		await setFlag(page, 'on')
		await mockTrialUsage(page, 240)
		await page.goto(`/${account.workspaceId}/settings/billing`)

		await expect(
			page.getByText('Work will wait at 100%. Choose a plan to keep going.').first(),
		).toBeVisible()
	})

	for (const theme of ['light', 'dark'] as const) {
		test(`the meter is visible in ${theme} mode`, async ({ page, account }) => {
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
			await setFlag(page, 'on')
			await mockTrialUsage(page, 240)
			await page.goto(`/${account.workspaceId}/settings/billing`)

			await expect(page.getByRole('progressbar', { name: 'Plan usage' }).first()).toBeVisible()
		})
	}

	test('with the flag off, no percent and no 100% banner', async ({ page, account }) => {
		await setFlag(page, 'off')
		await mockTrialUsage(page, CAP)
		await page.goto(`/${account.workspaceId}/settings/billing`)

		await expect(page.getByTestId('usage-banner')).toBeVisible()
		await expect(page.getByText('of your plan used')).toHaveCount(0)
		await expect(page.getByText('You have used 100% of your trial')).toHaveCount(0)
	})
})
