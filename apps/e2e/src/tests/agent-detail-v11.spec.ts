import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail v11 — triggers, Message, disabled banner', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`trigger switch persists and empty state offers New trigger @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const empty = await account.api.createAgentActor('Idle Ida')
			await account.api.addWorkspaceMember(account.workspaceId, empty.id)
			await page.goto(`/${account.workspaceId}/agents/${empty.id}`)

			// A new agent already has its Heartbeat trigger, so the empty copy is
			// covered by the unit test; here the picker is what matters.
			await expect(page.getByRole('switch', { name: /heartbeat/i })).toBeVisible({
				timeout: 10_000,
			})
			await page.getByRole('button', { name: /new trigger/i }).click()
			await expect(page.getByRole('dialog')).toBeVisible()
			await page.keyboard.press('Escape')

			const agent = await account.api.createAgentActor('Wake Wanda')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Triage events',
				type: 'event',
				action_prompt: 'Summarise the new event',
				target_actor_id: agent.id,
				config: { entity_type: 'insight', action: 'created' },
			})
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			const toggle = page.getByRole('switch', { name: /turn off triage events/i })
			await expect(toggle).toBeVisible({ timeout: 10_000 })
			await toggle.click()
			await expect(page.getByRole('switch', { name: /turn on triage events/i })).not.toBeChecked()

			await page.reload()
			await expect(page.getByRole('switch', { name: /turn on triage events/i })).not.toBeChecked()
		})

		test(`Message focuses the composer; Disable shows the banner @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Pause Pia')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await page.getByRole('button', { name: 'Message', exact: true }).click()
			await expect(page.getByRole('textbox', { name: 'Message Pause Pia' })).toBeFocused()

			const banner = page.getByText(
				'Disabled. Running sessions were held where they stopped. Enable the agent to continue.',
			)
			await expect(banner).toHaveCount(0)
			await page.getByRole('button', { name: 'Disable agent' }).click()
			await expect(banner).toBeVisible()

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(banner).toBeVisible()
			}
		})
	}
})
