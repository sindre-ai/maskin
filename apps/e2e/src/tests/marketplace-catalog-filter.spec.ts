import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Covers T2 of the Marketplace polish bet: the free-text catalog filter input
// and its empty state. The dev bootstrap seeds four bundle packages
// (Discover & Research, Build & Ship, Strategy & Growth, Team Ops) so the
// marketplace loads a real catalog on every run.

const FILTER_LABEL = 'Filter catalog'

async function noHorizontalOverflow(page: import('@playwright/test').Page) {
	const overflow = await page.evaluate(() => {
		const doc = document.documentElement
		return { scroll: doc.scrollWidth, client: doc.clientWidth }
	})
	expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)
}

test.describe('Marketplace catalog filter', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the filter input in the correct position at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const packagesSection = page.getByRole('region', { name: 'Packages' })
			await expect(packagesSection).toBeVisible({ timeout: 20000 })

			const visibleFilter = page
				.getByRole('searchbox', { name: FILTER_LABEL })
				.and(page.locator(':visible'))
			await expect(visibleFilter).toHaveCount(1)

			const filterBox = await visibleFilter.boundingBox()
			const packagesBox = await packagesSection.boundingBox()
			if (!filterBox || !packagesBox) throw new Error('missing bounding boxes')

			if (viewport.width < 768) {
				// Mobile: filter sits above the type chip strip (and therefore above the
				// grid), full-width across the content column.
				const typeChip = page.getByRole('button', { name: /^Agents\s/ }).first()
				const chipBox = await typeChip.boundingBox()
				if (!chipBox) throw new Error('missing chip bounding box')
				expect(filterBox.y + filterBox.height).toBeLessThanOrEqual(chipBox.y + 1)
				// Roughly fills the column (allow for the -mx-1/px-1 gutter).
				expect(filterBox.width).toBeGreaterThan(viewport.width * 0.85)
			} else {
				// Desktop / tablet: filter sits above the grid, right-aligned at ~320px.
				expect(filterBox.y + filterBox.height).toBeLessThanOrEqual(packagesBox.y + 1)
				expect(Math.round(filterBox.width)).toBeGreaterThanOrEqual(300)
				expect(Math.round(filterBox.width)).toBeLessThanOrEqual(340)
				const packagesRight = packagesBox.x + packagesBox.width
				const filterRight = filterBox.x + filterBox.width
				expect(Math.abs(packagesRight - filterRight)).toBeLessThan(24)
			}
		})
	}

	test('typing narrows the visible packages live', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		const packagesSection = page.getByRole('region', { name: 'Packages' })
		await expect(packagesSection).toBeVisible({ timeout: 20000 })
		await expect(packagesSection.getByRole('heading', { name: /Discover/ })).toBeVisible()
		await expect(packagesSection.getByRole('heading', { name: /Build & Ship/ })).toBeVisible()

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('discover')

		await expect(packagesSection.getByRole('heading', { name: /Discover/ })).toBeVisible()
		await expect(packagesSection.getByRole('heading', { name: /Build & Ship/ })).toHaveCount(0)
		await expect(packagesSection.getByRole('heading', { name: /Team Ops/ })).toHaveCount(0)
	})

	test('combines text query with a type chip (AND) on mobile', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		const chipNav = page.getByRole('navigation', { name: 'Marketplace filters' })
		await expect(chipNav).toBeVisible({ timeout: 20000 })

		// Narrow to Triggers first so only the Triggers section renders.
		await chipNav.getByRole('button', { name: /^Triggers\s/ }).click()
		const triggersSection = page.getByRole('region', { name: 'Triggers' })
		await expect(triggersSection).toBeVisible()
		await expect(page.getByRole('region', { name: 'Packages' })).toHaveCount(0)

		// Add a text query that only matches one of the seeded triggers.
		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('sweep')

		// Both filters still apply: still only in the Triggers section, and only
		// items whose snapshot matches the query remain.
		await expect(triggersSection).toBeVisible()
		await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0)
		await expect(page.getByRole('region', { name: 'Packages' })).toHaveCount(0)
		const cards = triggersSection.locator('article')
		const cardCount = await cards.count()
		expect(cardCount).toBeGreaterThan(0)
		for (let i = 0; i < cardCount; i++) {
			await expect(cards.nth(i)).toContainText(/sweep/i)
		}
	})

	test('renders a clean empty state when the query matches nothing', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		await expect(page.getByRole('region', { name: 'Packages' })).toBeVisible({ timeout: 20000 })

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('zzzznomatchxyz')

		await expect(page.getByText('No matches')).toBeVisible()
		await expect(page.getByRole('region', { name: 'Packages' })).toHaveCount(0)
		await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0)
		// No stale count line — the old catalog empty-state copy must not leak.
		await expect(page.getByText(/No packages yet/i)).toHaveCount(0)
		await expect(page.getByText(/Showing all/i)).toHaveCount(0)
	})

	test('layout holds at 375px across default, typing, and empty states', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		await expect(page.getByRole('region', { name: 'Packages' })).toBeVisible({ timeout: 20000 })
		await noHorizontalOverflow(page)

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('discover')
		await expect(
			page.getByRole('region', { name: 'Packages' }).getByRole('heading', { name: /Discover/ }),
		).toBeVisible()
		await noHorizontalOverflow(page)

		await filter.fill('zzzznomatchxyz')
		await expect(page.getByText('No matches')).toBeVisible()
		await noHorizontalOverflow(page)
	})
})
