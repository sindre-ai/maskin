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

			// Header team pill shows the workspace name and the pause toggle
			// (Run when idle) is reachable.
			await expect(page.getByRole('button', { name: /^Run$/ })).toBeVisible()

			// Usage block: label, tabs, both columns, budget line.
			const usage = page.getByRole('region', { name: 'Usage' })
			await expect(usage).toBeVisible()
			await expect(usage.getByText('Usage', { exact: true })).toBeVisible()
			await expect(usage.getByRole('button', { name: '24h' })).toBeVisible()
			await expect(usage.getByRole('button', { name: '30d' })).toBeVisible()
			await expect(usage.getByText('tokens used')).toBeVisible()
			await expect(usage.getByText('sessions', { exact: true })).toBeVisible()
			await expect(usage.getByText('TOKENS / MONTH')).toBeVisible()
			await expect(usage.getByText(/Budget: No cap/)).toBeVisible()

			// Switching to 7d re-labels the chart — proves the tabs drive the
			// window, not just cosmetic state.
			await usage.getByRole('button', { name: '7d' }).click()
			await expect(usage.getByText('TOKENS / WEEK')).toBeVisible()

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
