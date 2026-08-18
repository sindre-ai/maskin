import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — Sessions section', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders the Sessions region on the detail route @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Sam Sessions')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const section = page.getByRole('region', { name: 'Sessions' })
			await expect(section).toBeVisible({ timeout: 10_000 })

			// Empty state shows when the agent hasn't run anything yet — proves the
			// section renders even without data on the deployed slot.
			await expect(section.getByText('No sessions yet. Runs will show up here.')).toBeVisible()

			// Both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(section).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
