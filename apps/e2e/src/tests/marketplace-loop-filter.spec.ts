import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Covers T2 of the Marketplace polish bet: the free-text marketplace filter
// input and its empty state. The dev bootstrap seeds four bundle loops
// (Discover & Research, Build & Ship, Strategy & Growth, Team Ops) so the
// marketplace loads a real set of loops on every run.

const FILTER_LABEL = 'Filter marketplace'
const EMPTY_COPY = 'Nothing in the catalog matches those filters.'

async function noHorizontalOverflow(page: import('@playwright/test').Page) {
	const overflow = await page.evaluate(() => {
		const doc = document.documentElement
		return { scroll: doc.scrollWidth, client: doc.clientWidth }
	})
	expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)
}

test.describe('Marketplace loop filter', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the filter input in the correct position at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const loopsSection = page.getByRole('region', { name: 'Flows' })
			await expect(loopsSection).toBeVisible({ timeout: 20000 })

			const visibleFilter = page
				.getByRole('searchbox', { name: FILTER_LABEL })
				.and(page.locator(':visible'))
			await expect(visibleFilter).toHaveCount(1)

			const filterBox = await visibleFilter.boundingBox()
			const loopsBox = await loopsSection.boundingBox()
			if (!filterBox || !loopsBox) throw new Error('missing bounding boxes')

			// Shared page edge: the title and the chip strip start on one left edge.
			const title = page.getByRole('heading', { level: 1, name: 'Marketplace' })
			const titleBox = await title.boundingBox()
			if (!titleBox) throw new Error('missing title bounding box')
			// The shared page title scale: 34px from 1024, 28px at 768, 24px below.
			await expect(title).toHaveCSS(
				'font-size',
				viewport.width >= 1024 ? '34px' : viewport.width >= 768 ? '28px' : '24px',
			)

			const typeChips = page.getByTestId('marketplace-filter-chips')
			const chipBox = await typeChips.boundingBox()
			if (!chipBox) throw new Error('missing chip bounding box')

			// From 768 the title and the chips start on one left edge (on a phone the
			// header leads with the sidebar toggle, so the title sits right of it).
			if (viewport.width >= 768) {
				expect(Math.abs(chipBox.x - titleBox.x)).toBeLessThanOrEqual(1)
			}

			// The visible box of the search field is its pill (the label around the input).
			const pill = await visibleFilter.locator('xpath=ancestor::label').boundingBox()
			if (!pill) throw new Error('missing filter pill bounding box')

			if (viewport.width < 1024) {
				// Phone and iPad portrait: the chip row sits above the stacked search field.
				expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(pill.y + 1)
				if (viewport.width < 768) expect(pill.width).toBeGreaterThan(viewport.width * 0.85)
			} else {
				// Desktop / iPad landscape: filter shares a row with the chip strip (type and
				// use-case filters are a single combined list), sits to its right, above
				// the grid, right-aligned at ~320px. Uses the chip-row wrapper's clipped
				// bounding box, not an individual chip's, since the wrapper is
				// overflow-x-auto and a single chip's layout box can exceed the visible
				// clipped region.
				// The chips wrap onto further lines (v16), so the filter lines up with
				// the first chip line, not the middle of the whole strip.
				expect(Math.abs(pill.y - chipBox.y)).toBeLessThan(4)
				expect(pill.x).toBeGreaterThan(chipBox.x + chipBox.width - 1)
				expect(pill.y + pill.height).toBeLessThanOrEqual(loopsBox.y + 1)
				expect(Math.round(pill.width)).toBe(288)
				const loopsRight = loopsBox.x + loopsBox.width
				const filterRight = pill.x + pill.width
				expect(Math.abs(loopsRight - filterRight)).toBeLessThan(24)
			}
		})
	}

	test('typing narrows the visible loops live', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		const loopsSection = page.getByRole('region', { name: 'Flows' })
		await expect(loopsSection).toBeVisible({ timeout: 20000 })
		await expect(loopsSection.getByRole('heading', { name: /Discover & Research/ })).toBeVisible()
		await expect(loopsSection.getByRole('heading', { name: /Build & Ship/ })).toBeVisible()

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('discover')

		await expect(loopsSection.getByRole('heading', { name: /Discover & Research/ })).toBeVisible()
		await expect(loopsSection.getByRole('heading', { name: /Build & Ship/ })).toHaveCount(0)
		await expect(loopsSection.getByRole('heading', { name: /Team Ops/ })).toHaveCount(0)
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
		await expect(page.getByRole('region', { name: 'Flows' })).toHaveCount(0)

		// Add a text query that only matches one of the seeded triggers.
		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('sweep')

		// Both filters still apply: still only in the Triggers section, and only
		// items whose snapshot matches the query remain.
		await expect(triggersSection).toBeVisible()
		await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0)
		await expect(page.getByRole('region', { name: 'Flows' })).toHaveCount(0)
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

		await expect(page.getByRole('region', { name: 'Flows' })).toBeVisible({ timeout: 20000 })

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('zzzznomatchxyz')

		await expect(page.getByText(EMPTY_COPY)).toBeVisible()
		await expect(page.getByRole('region', { name: 'Flows' })).toHaveCount(0)
		await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0)
		// No stale count line — the old marketplace empty-state copy must not leak.
		await expect(page.getByText(/No flows yet/i)).toHaveCount(0)
		await expect(page.getByText(/Showing all/i)).toHaveCount(0)
	})

	test('Clear filters from the empty state resets the query and the active chip', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktopXl.width,
			height: VIEWPORTS.desktopXl.height,
		})
		await page.goto(`/${account.workspaceId}/marketplace`)

		await expect(page.getByRole('region', { name: 'Flows' })).toBeVisible({ timeout: 20000 })

		// Select the Triggers chip (a section with real seeded items), then drive
		// the query to "No matches" so the clearable empty state is what shows.
		const chips = page.getByTestId('marketplace-filter-chips')
		await chips.getByRole('button', { name: /^Triggers\s/ }).click()
		await expect(page.getByRole('region', { name: 'Triggers' })).toBeVisible()

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('zzzznomatchxyz')
		await expect(page.getByText(EMPTY_COPY)).toBeVisible()

		// "Clear filters" resets the search box and returns the catalog to "All".
		// exact:true disambiguates from the sidebar workspace-switcher buttons,
		// whose accessible name embeds the session workspace name ("E2E Clear
		// filters from the empty state ...'s Workspace").
		await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
		await expect(filter).toHaveValue('')
		await expect(page.getByRole('region', { name: 'Flows' })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Triggers' })).toBeVisible()
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

		await expect(page.getByRole('region', { name: 'Flows' })).toBeVisible({ timeout: 20000 })
		await noHorizontalOverflow(page)

		const filter = page.getByRole('searchbox', { name: FILTER_LABEL }).and(page.locator(':visible'))
		await filter.fill('discover')
		await expect(
			page
				.getByRole('region', { name: 'Flows' })
				.getByRole('heading', { name: /Discover & Research/ }),
		).toBeVisible()
		await noHorizontalOverflow(page)

		await filter.fill('zzzznomatchxyz')
		await expect(page.getByText(EMPTY_COPY)).toBeVisible()
		await noHorizontalOverflow(page)
	})
})
