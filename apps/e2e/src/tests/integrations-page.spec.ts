import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Settings → Integrations (shelves layout)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`search, pills, shelves and cards work @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createCustomMcpServer(account.workspaceId, 'internal-crm', {
				type: 'http',
				url: 'https://example.com/mcp',
			})

			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// One long page: Your integrations first, then the shelves. No tabs.
			const search = page.getByRole('searchbox', { name: 'Search integrations and tools' })
			await expect(search).toBeVisible({ timeout: 10_000 })
			await expect(page.getByRole('button', { name: /^Discover/ })).toHaveCount(0)
			const yours = page.getByRole('region', { name: 'Your integrations' })
			await expect(yours).toBeVisible()
			await expect(page.getByRole('region', { name: 'Popular' })).toBeVisible()
			await expect(page.getByRole('region', { name: 'All integrations' })).toBeVisible()

			// The custom server is a collapsed card; its chevron opens it.
			const card = yours.getByRole('button', { name: 'internal-crm', exact: true })
			await expect(card).toHaveAttribute('aria-expanded', 'false')
			await card.click()
			await expect(card).toHaveAttribute('aria-expanded', 'true')

			// The add card is there until a search starts.
			const addCard = page.getByRole('button', { name: /Add your own MCP server/ })
			await expect(addCard).toBeVisible()
			await search.fill('crm')
			await expect(addCard).toBeHidden()
			await expect(card).toBeVisible()

			// A search that matches nothing says so, with a way back.
			await search.fill('zzzz')
			await expect(page.getByText('No integration matches that search')).toBeVisible()
			await search.fill('')

			// A pill narrows the same page in place; the list takes the pill's name.
			await page.getByRole('button', { name: 'Custom' }).click()
			await expect(page.getByRole('region', { name: 'All integrations' })).toBeHidden()
			await page.getByRole('button', { name: 'Code', exact: true }).click()
			const code = page.getByRole('region', { name: 'Code' })
			await expect(code.getByText('GitHub')).toBeVisible()
			await expect(code.getByText('Gmail')).toBeHidden()

			// No horizontal scroll on the page itself.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}

	for (const scheme of ['light', 'dark'] as const) {
		test(`cards are visible in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}/settings/integrations`)
			await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible({
				timeout: 10_000,
			})
		})
	}
})
