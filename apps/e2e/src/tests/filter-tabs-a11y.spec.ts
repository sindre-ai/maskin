import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Shared FilterTabs (T6 of bet `ux-review-core-pages`) uses path (b) of the
// AC: role="group" + <button aria-pressed>, not role="tablist". These specs
// pin that contract so a future refactor can't quietly reintroduce a partial
// tablist ARIA that promises arrow-key nav we don't ship.

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Objects type tabs at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('expose aria-pressed and activate via Enter/Space', async ({ page, account }) => {
			await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Aria Test Insight',
				status: 'new',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Aria Test Bet',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Aria Test Insight')).toBeVisible({ timeout: 10000 })

			const all = page.getByRole('button', { name: 'All' })
			const insights = page.getByRole('button', { name: 'Insights' })
			const bets = page.getByRole('button', { name: 'Bets' })

			await expect(all).toHaveAttribute('aria-pressed', 'true')
			await expect(insights).toHaveAttribute('aria-pressed', 'false')

			// The chosen ARIA contract is role="group" — no dangling tablist promise.
			await expect(page.locator('[role="tablist"]')).toHaveCount(0)
			await expect(page.locator('[role="tab"]')).toHaveCount(0)

			await insights.focus()
			await page.keyboard.press('Enter')
			await expect(insights).toHaveAttribute('aria-pressed', 'true')
			await expect(all).toHaveAttribute('aria-pressed', 'false')
			await expect(page.getByText('Aria Test Insight')).toBeVisible()
			await expect(page.getByText('Aria Test Bet')).not.toBeVisible()

			await bets.focus()
			await page.keyboard.press(' ')
			await expect(bets).toHaveAttribute('aria-pressed', 'true')
			await expect(page.getByText('Aria Test Bet')).toBeVisible()
		})
	})
}
