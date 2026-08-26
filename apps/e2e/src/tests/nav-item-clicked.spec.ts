import { expect, test } from '../fixtures/auth.fixture'

// Event probe for the nav-cleanup bet: `nav_item_clicked` must fire from both
// the top-nav slot (Agents, Triggers, For You) and the footer slot (Marketplace,
// which was moved out of coreNavItems in T4). Mirrors the console-fallback
// approach used by `scroll-to-top.spec.ts`: CI runs without `VITE_POSTHOG_KEY`,
// so posthog-js stays uninitialised and `trackEvent` logs `[analytics] ...` to
// the browser console instead of firing an XHR to `eu.i.posthog.com/e/`. The
// payload shape is identical either way, so console-line assertions prove the
// contract without needing PostHog reachable from CI.

interface AnalyticsPayload {
	name: string
	item_key?: string
	source?: string
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

test('nav_item_clicked fires with the stable item_key + top-nav source when a top-nav entry is clicked', async ({
	page,
	account,
}) => {
	const analyticsCalls = collectAnalytics(page)

	await page.goto(`/${account.workspaceId}`)
	// Wait for the sidebar to mount before clicking a nav entry. Agents left the
	// top nav in the v2 shell (it is reached from the footer activity card, which
	// the footer-source test below covers) — Loops is a top-nav entry there.
	await expect(page.getByRole('link', { name: 'Loops' }).first()).toBeVisible({ timeout: 10_000 })

	await page.getByRole('link', { name: 'Loops' }).first().click()

	// Allow the console-fallback microtask to settle.
	await page.waitForTimeout(200)

	const navClicks = analyticsCalls.filter((c) => c.name === 'nav_item_clicked')
	expect(navClicks).toHaveLength(1)
	expect(navClicks[0]).toMatchObject({
		name: 'nav_item_clicked',
		item_key: 'loops',
		source: 'top-nav',
	})
})

test('nav_item_clicked fires with source=footer when Marketplace is clicked from the sidebar footer', async ({
	page,
	account,
}) => {
	const analyticsCalls = collectAnalytics(page)

	await page.goto(`/${account.workspaceId}`)
	await expect(page.getByRole('link', { name: 'Marketplace' }).first()).toBeVisible({
		timeout: 10_000,
	})

	await page.getByRole('link', { name: 'Marketplace' }).first().click()

	await page.waitForTimeout(200)

	const navClicks = analyticsCalls.filter((c) => c.name === 'nav_item_clicked')
	expect(navClicks).toHaveLength(1)
	expect(navClicks[0]).toMatchObject({
		name: 'nav_item_clicked',
		item_key: 'marketplace',
		source: 'footer',
	})
})
