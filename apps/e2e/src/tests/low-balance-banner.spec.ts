import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The low-balance banner (Task 6775ef6c under bet/6d84-credit-reliability)
 * renders inside the workspace shell above <main> when a positive credit
 * balance falls at or below MAX(200¢, 20% of last-30d topups). It emits a
 * `credits_low_balance_banner_shown` PostHog event on FIRST render per
 * workspace-session (not per pageview) and is dismissible per session.
 *
 * CI can't fund a real Stripe top-up, so the low-balance state is stubbed by
 * intercepting GET /api/billing/usage — the same route the shell fetches
 * through `useBillingUsage`. The visual layer is driven by the test-only
 * `ff:maskin-credit-ux` localStorage override, mirroring the pattern in
 * `insufficient-credits-modal.spec.ts`.
 */

const CREDIT_UX_FLAG = 'maskin-credit-ux'

interface UsageOverrides {
	credit_balance_cents?: number
	sum_topups_last_30d_cents?: number
	plan?: 'trial' | 'pro' | 'team' | 'enterprise'
}

function buildUsageBody(overrides: UsageOverrides = {}): string {
	return JSON.stringify({
		plan: overrides.plan ?? 'pro',
		status: 'active',
		usd_cents_used: 0,
		hard_cap_usd_cents: 2_000,
		period_start: null,
		period_resets_in_ms: 30 * 24 * 60 * 60 * 1000,
		stripe_customer_id: null,
		stripe_subscription_id: null,
		credit_balance_cents: overrides.credit_balance_cents ?? 185,
		sum_topups_last_30d_cents: overrides.sum_topups_last_30d_cents ?? 0,
		linkedin_identity_addon: null,
	})
}

interface AnalyticsPayload {
	name: string
	workspace_id?: string
	balance_cents?: number
	threshold_used?: number
}

function collectAnalytics(page: import('@playwright/test').Page): AnalyticsPayload[] {
	const calls: AnalyticsPayload[] = []
	page.on('console', (msg) => {
		if (msg.type() !== 'info') return
		const args = msg.args()
		if (args.length < 2) return
		Promise.all(args.map((a) => a.jsonValue().catch(() => null)))
			.then((values) => {
				const [tag, payload] = values as [unknown, AnalyticsPayload | null]
				if (tag === '[analytics]' && payload && typeof payload === 'object') {
					calls.push(payload)
				}
			})
			.catch(() => {})
	})
	return calls
}

async function interceptBillingUsage(
	page: import('@playwright/test').Page,
	overrides: UsageOverrides = {},
) {
	await page.route('**/api/billing/usage', async (route) => {
		if (route.request().method() !== 'GET') {
			await route.fallback()
			return
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: buildUsageBody(overrides),
		})
	})
}

test.describe('LowBalanceBanner — persistent workspace-shell warning', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders below-threshold balance @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const analyticsCalls = collectAnalytics(page)

			// The theme key is seeded so the app follows prefers-color-scheme;
			// without it emulateMedia below would be inert.
			await page.addInitScript((flag: string) => {
				localStorage.setItem(`ff:${flag}`, 'on')
				localStorage.setItem('maskin-theme', 'system')
			}, CREDIT_UX_FLAG)

			// $1.85 balance — under the $2 floor.
			await interceptBillingUsage(page, { credit_balance_cents: 185 })
			await page.goto(`/${account.workspaceId}`)

			const banner = page.getByTestId('low-balance-banner')
			await expect(banner).toBeVisible({ timeout: 10_000 })
			await expect(
				banner.getByText(/Low credit balance \(\$1\.85\)\. Top up to keep your agents running\./),
			).toBeVisible()
			await expect(banner.getByRole('link', { name: 'Top up credits' })).toBeVisible()

			// Dark-theme parity — reachable and legible in both modes.
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
			await expect(banner).toBeVisible()

			await page.emulateMedia({ colorScheme: 'light' })
			await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/)
			await expect(banner).toBeVisible()

			// The banner event fires on first render with the concrete threshold.
			await page.waitForTimeout(200)
			const shown = analyticsCalls.filter((c) => c.name === 'credits_low_balance_banner_shown')
			expect(shown).toHaveLength(1)
			expect(shown[0]).toMatchObject({
				workspace_id: account.workspaceId,
				balance_cents: 185,
				threshold_used: 200,
			})
		})
	}

	test('does not render when balance is above the threshold', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.addInitScript((flag: string) => {
			localStorage.setItem(`ff:${flag}`, 'on')
		}, CREDIT_UX_FLAG)

		// $50 balance vs. 20% of $100 topups = $20 threshold — banner stays off.
		await interceptBillingUsage(page, {
			credit_balance_cents: 5_000,
			sum_topups_last_30d_cents: 10_000,
		})
		await page.goto(`/${account.workspaceId}`)

		// Wait for the shell to hydrate the billing query before asserting
		// absence — otherwise a race between the intercept and mount could
		// pass the assertion just because the banner has not fetched yet.
		await page.waitForResponse('**/api/billing/usage')
		await expect(page.getByTestId('low-balance-banner')).toHaveCount(0)
	})

	test('does not render when MASKIN_CREDIT_UX is off', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		// No flag override — flag defaults off in CI, so the shell boundary is
		// off even though the balance would otherwise flip it on.
		await interceptBillingUsage(page, { credit_balance_cents: 185 })
		await page.goto(`/${account.workspaceId}`)

		await page.waitForResponse('**/api/billing/usage')
		await expect(page.getByTestId('low-balance-banner')).toHaveCount(0)
	})

	test('is dismissible per session and the dismiss button hides the banner', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.addInitScript((flag: string) => {
			localStorage.setItem(`ff:${flag}`, 'on')
		}, CREDIT_UX_FLAG)

		await interceptBillingUsage(page, { credit_balance_cents: 185 })
		await page.goto(`/${account.workspaceId}`)

		const banner = page.getByTestId('low-balance-banner')
		await expect(banner).toBeVisible({ timeout: 10_000 })

		await banner.getByRole('button', { name: 'Dismiss low balance warning' }).click()
		await expect(banner).toHaveCount(0)
	})

	test('primary CTA routes to the billing settings surface', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.addInitScript((flag: string) => {
			localStorage.setItem(`ff:${flag}`, 'on')
		}, CREDIT_UX_FLAG)

		await interceptBillingUsage(page, { credit_balance_cents: 185 })
		await page.goto(`/${account.workspaceId}`)

		const banner = page.getByTestId('low-balance-banner')
		await expect(banner).toBeVisible({ timeout: 10_000 })

		await banner.getByRole('link', { name: 'Top up credits' }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings/billing`))
	})
})
