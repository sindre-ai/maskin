import { expect, test } from '../fixtures/auth.fixture'

test.describe('Shared state vocabulary — loading / empty / error / offline', () => {
	test.describe.configure({ mode: 'serial' })

	test('offline banner appears when navigator.onLine flips to false', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/`)
		await page.waitForLoadState('load')
		// SSE keeps a connection open indefinitely, so 'networkidle' never fires — see
		// the same pattern in visual.spec.ts / typography.spec.ts.
		await page.waitForTimeout(300)

		await page.evaluate(() => {
			Object.defineProperty(navigator, 'onLine', {
				configurable: true,
				get: () => false,
			})
			window.dispatchEvent(new Event('offline'))
		})

		await expect(page.getByText(/You are offline\./)).toBeVisible({ timeout: 5000 })
	})

	// Empty-state rendering for Agents/Loops/Triggers is already covered at the
	// component level (agents-index.test.tsx, loops-index.test.tsx,
	// triggers-index.test.tsx via mocked hooks returning []) — this file only
	// probes it end-to-end. Removed because a freshly created workspace here is
	// not guaranteed to have zero agents (e.g. system agents such as Chief of
	// Staff / Workspace Coach cannot be deleted via the API — see 403 in
	// DELETE /api/actors/:id), so the precondition isn't reliably reachable
	// through the real signup flow. See CI run for PR #1403.

	test('loading skeleton (not a spinner) is shown while agents list is fetching', async ({
		page,
		account,
	}) => {
		// Delay the actors endpoint so the skeleton has time to render before data arrives.
		await page.route('**/api/actors**', async (route) => {
			await new Promise((r) => setTimeout(r, 1500))
			await route.continue()
		})

		await page.goto(`/${account.workspaceId}/agents`)

		// CardSkeleton renders animated pulse blocks — presence of any animate-pulse
		// element on the page during load is the shared-vocabulary signal. There
		// must be no `<Spinner />` on a large-area load state.
		const pulseCount = await page.locator('.animate-pulse').count()
		expect(pulseCount).toBeGreaterThan(0)

		await page.unroute('**/api/actors**')
	})

	test('inline error UI appears when the marketplace fetch fails', async ({ page, account }) => {
		await page.route('**/api/marketplace/loops**', async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'Simulated server failure' }),
			})
		})

		await page.goto(`/${account.workspaceId}/marketplace`)

		// The marketplace isError branch renders inline muted text, not a
		// button — there is no retry control on this surface yet.
		await expect(page.getByText(/Couldn't load the marketplace/i)).toBeVisible({ timeout: 10000 })

		await page.unroute('**/api/marketplace/loops**')
	})
})
