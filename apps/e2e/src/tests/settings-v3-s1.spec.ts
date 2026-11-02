import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v3 Settings part 1: trial card + Billing, General tool/device rows, Triggers,
// Item types with the Add property dialog, Keychain.

const DAY_MS = 24 * 60 * 60 * 1000

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function mockTrialUsage(page: Page, resetsInMs: number) {
	await page.route('**/api/billing/usage*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				plan: 'trial',
				status: 'active',
				usd_cents_used: 125,
				hard_cap_usd_cents: 1_000,
				period_start: null,
				period_resets_in_ms: resetsInMs,
				stripe_customer_id: null,
				stripe_subscription_id: null,
				credit_balance_cents: 0,
				credit_topup_available: true,
				linkedin_identity_addon: null,
			}),
		})
	})
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('Settings v3 (part 1)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test.describe(vp.label, () => {
			test.beforeEach(async ({ page }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
			})

			for (const theme of ['light', 'dark'] as const) {
				test(`Billing shows the trial banner and Choose a plan opens the plans — ${theme}`, async ({
					page,
					account,
				}) => {
					await setTheme(page, theme)
					await mockTrialUsage(page, 4.2 * DAY_MS)
					await page.goto(`/${account.workspaceId}/settings/billing`)

					const banner = page.getByTestId('trial-banner')
					await expect(banner.getByText('Trial ends in 5 days')).toBeVisible()
					await expect(banner.getByText('Choose a plan to keep agents running.')).toBeVisible()

					await page.getByRole('button', { name: 'Hide plans' }).click()
					await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).not.toBeVisible()
					await banner.getByRole('button', { name: 'Choose a plan' }).click()
					await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible()

					// Usage is listed by agent and always shown, not behind a disclosure.
					await expect(page.getByText('By agent')).toBeVisible()
					await expectNoHorizontalOverflow(page)
				})
			}

			test('the left-nav trial card shows the days left above Marketplace', async ({
				page,
				account,
			}) => {
				test.skip(vp.width < 768, 'The sidebar is a drawer below 768px')
				await mockTrialUsage(page, 4.2 * DAY_MS)
				await page.goto(`/${account.workspaceId}`)

				const card = page.getByRole('region', { name: 'Trial' })
				await expect(card.getByText('Trial ends in 5 days')).toBeVisible()
				await expect(card.getByRole('link', { name: 'Upgrade' })).toBeVisible()
				const cardBox = await card.boundingBox()
				const marketplaceBox = await page.getByRole('link', { name: 'Marketplace' }).boundingBox()
				expect(cardBox && marketplaceBox && cardBox.y < marketplaceBox.y).toBe(true)
			})

			test('General links to Triggers and Sign in a device', async ({ page, account }) => {
				await page.goto(`/${account.workspaceId}/settings`)

				await expect(page.getByRole('heading', { name: 'Workspace tools' })).toBeVisible()
				await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible()
				await expect(page.getByRole('link', { name: 'Sign in a device' })).toBeVisible()
				await expectNoHorizontalOverflow(page)

				await page.getByRole('link', { name: 'Triggers' }).first().click()
				await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/triggers$`))
				await expect(page.getByRole('heading', { name: 'In flows' })).toBeVisible()
				await expect(page.getByRole('heading', { name: 'Not tied to a flow' })).toBeVisible()
				await expect(page.getByRole('button', { name: /New trigger/ })).toBeVisible()
			})

			test('Item types: Add property dialog saves a property that survives a reload', async ({
				page,
				account,
			}) => {
				await page.goto(`/${account.workspaceId}/settings/objects`)
				await page
					.getByRole('link', { name: /propert(y|ies)$/ })
					.first()
					.click()

				const name = `Budget ${Date.now()}`
				await page.getByRole('button', { name: 'Add property' }).click()
				const dialog = page.getByRole('dialog')
				await expect(dialog.getByRole('radio')).toHaveCount(5)
				await dialog.getByLabel('Name').fill(name)
				await dialog.getByRole('radio', { name: 'Number' }).click()
				await dialog.getByRole('button', { name: 'Add property' }).click()

				await expect(page.getByRole('link', { name })).toBeVisible()
				await page.reload()
				await expect(page.getByRole('link', { name })).toBeVisible()
				await expectNoHorizontalOverflow(page)
			})

			test('Keychain page renders without overflow', async ({ page, account }) => {
				await page.goto(`/${account.workspaceId}/settings/keychain`)
				await expect(page.getByText('Keychain').first()).toBeVisible()
				await expectNoHorizontalOverflow(page)
			})
		})
	}
})
