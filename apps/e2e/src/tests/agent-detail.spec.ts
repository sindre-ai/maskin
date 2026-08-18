import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — header and Usage block', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders header, outcome line and Usage block @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const outcome = 'Keeps the marketing pipeline unclogged'
			const agent = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			// Set the one-line role that surfaces as "Owns one outcome". The
			// PATCH goes through the same schema the UI reads back from useActor.
			await (
				account.api as unknown as {
					updateActor(id: string, data: { description: string }): Promise<unknown>
				}
			).updateActor(agent.id, { description: outcome })

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('heading', { name: 'Ada Atom' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByText('Owns one outcome:')).toBeVisible()
			await expect(page.getByText(outcome)).toBeVisible()

			// The agent-level action lives in the shared nav row (mockup 2351) and
			// is reachable at every viewport…
			const runButton = page.getByRole('button', { name: /^Run$/ })
			await expect(runButton).toBeVisible()
			// …and no longer sits in the page body beside the outcome line.
			await expect(page.locator('.max-w-3xl').getByRole('button', { name: /^Run$/ })).toHaveCount(0)

			// Usage block: label, tabs, both columns, budget line.
			const usage = page.getByRole('region', { name: 'Usage' })
			await expect(usage).toBeVisible()
			await expect(usage.getByText('Usage', { exact: true })).toBeVisible()
			await expect(usage.getByRole('button', { name: '24h' })).toBeVisible()
			await expect(usage.getByRole('button', { name: '30d' })).toBeVisible()
			await expect(usage.getByText('tokens used')).toBeVisible()
			await expect(usage.getByText('sessions', { exact: true })).toBeVisible()
			await expect(usage.getByText('TOKENS / MONTH')).toBeVisible()
			// No cap is configured, so the budget row reports the month's spend.
			await expect(usage.getByText(/No cap — .+ this month/)).toBeVisible()

			// Switching to 7d re-labels the chart — proves the tabs drive the
			// window, not just cosmetic state.
			await usage.getByRole('button', { name: '7d' }).click()
			await expect(usage.getByText('TOKENS / WEEK')).toBeVisible()

			// 90d is the mockup's third period (2381) and gets its own label.
			await usage.getByRole('button', { name: '90d' }).click()
			await expect(usage.getByText('TOKENS / QUARTER')).toBeVisible()

			// The header and Usage block render in both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('heading', { name: 'Ada Atom' })).toBeVisible()
				await expect(usage).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
