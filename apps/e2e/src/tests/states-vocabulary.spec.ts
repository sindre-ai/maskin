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

	test('empty state renders on Agents list when workspace has no agents', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByText('No agents in this workspace')).toBeVisible({ timeout: 10000 })
	})

	test('empty state renders on Loops list when no loops installed', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('No loops running here yet')).toBeVisible({ timeout: 10000 })
	})

	test('empty state renders on Triggers list when workspace has no triggers', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/triggers`)
		await expect(page.getByText(/No triggers/i)).toBeVisible({ timeout: 10000 })
	})

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
