import { expect, test } from '../fixtures/auth.fixture'

// T2 event probe — clicks a top-nav entry and asserts `nav_item_clicked` fires
// with `{item_key, source: 'top-nav'}`. Mirrors the console-fallback approach
// used by `scroll-to-top.spec.ts`: CI runs without `VITE_POSTHOG_KEY`, so
// posthog-js stays uninitialised and `trackEvent` logs `[analytics] ...` to the
// browser console instead of firing an XHR to `eu.i.posthog.com/e/`. The
// payload shape is identical either way, so console-line assertions prove the
// contract without needing PostHog reachable from CI.
//
// Footer coverage is deferred to T4, which repositions Marketplace into the
// footer through the shared `SidebarNavItem` — the source will flip to
// 'footer' automatically at that point.

interface AnalyticsPayload {
	name: string
	item_key?: string
	source?: string
}

test('nav_item_clicked fires with the stable item_key + top-nav source when a top-nav entry is clicked', async ({
	page,
	account,
}) => {
	const analyticsCalls: AnalyticsPayload[] = []
	page.on('console', (msg) => {
		if (msg.type() !== 'info') return
		const args = msg.args()
		if (args.length < 2) return
		Promise.all(args.map((a) => a.jsonValue().catch(() => null)))
			.then((values) => {
				const [tag, payload] = values as [unknown, AnalyticsPayload | null]
				if (tag === '[analytics]' && payload && typeof payload === 'object') {
					analyticsCalls.push(payload)
				}
			})
			.catch(() => {})
	})

	await page.goto(`/${account.workspaceId}`)
	// Wait for the sidebar to mount before clicking a nav entry.
	await expect(page.getByRole('link', { name: 'Agents' }).first()).toBeVisible({ timeout: 10_000 })

	await page.getByRole('link', { name: 'Agents' }).first().click()

	// Allow the console-fallback microtask to settle.
	await page.waitForTimeout(200)

	const navClicks = analyticsCalls.filter((c) => c.name === 'nav_item_clicked')
	expect(navClicks).toHaveLength(1)
	expect(navClicks[0]).toMatchObject({
		name: 'nav_item_clicked',
		item_key: 'agents',
		source: 'top-nav',
	})
})
