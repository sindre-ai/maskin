import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Settings → Integrations (v3 layout)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`tabs, search, categories and cards work @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createCustomMcpServer(account.workspaceId, 'internal-crm', {
				type: 'http',
				url: 'https://example.com/mcp',
			})

			await page.goto(`/${account.workspaceId}/settings/integrations`)

			// Two tabs with counts; the custom server makes Connected non-empty.
			const connectedTab = page.getByRole('button', { name: /^Connected \(\d+\)$/ })
			const discoverTab = page.getByRole('button', { name: /^Discover \(\d+\)$/ })
			await expect(connectedTab).toBeVisible({ timeout: 10_000 })
			await expect(discoverTab).toBeVisible()
			await expect(connectedTab).toHaveAttribute('aria-pressed', 'true')

			// The custom server is a collapsed card; its chevron opens it.
			const card = page.getByRole('button', { name: 'internal-crm', exact: true })
			await expect(card).toHaveAttribute('aria-expanded', 'false')
			await card.click()
			await expect(card).toHaveAttribute('aria-expanded', 'true')

			// The add card is there until a search starts.
			const addCard = page.getByRole('button', { name: /Add your own MCP server/ })
			await expect(addCard).toBeVisible()
			const search = page.getByRole('searchbox', { name: 'Search integrations and tools' })
			await search.fill('crm')
			await expect(addCard).toBeHidden()
			await expect(card).toBeVisible()
			await search.fill('')

			// Discover lists unconnected providers; a category chip narrows them.
			await discoverTab.click()
			await expect(discoverTab).toHaveAttribute('aria-pressed', 'true')
			await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible()
			await page.getByRole('button', { name: 'Code' }).click()
			await expect(page.getByText('GitHub')).toBeVisible()
			await expect(page.getByText('Gmail')).toBeHidden()

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
			await page.getByRole('button', { name: /^Discover \(\d+\)$/ }).click()
			await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible({
				timeout: 10_000,
			})
		})
	}
})
