import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loop detail — Chat tab', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`opens the loop's group chat, sends a message, and keeps the tab on reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Lena Looper')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback loop',
				status: 'learning',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Nightly sweep',
				type: 'cron',
				action_prompt: 'Sweep the feedback queue',
				target_actor_id: agent.id,
				config: { expression: '0 3 * * *' },
			})
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id] },
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await page.getByRole('tab', { name: 'Chat' }).click()
			await expect(page).toHaveURL(/tab=chat/)

			const message = 'Why is this loop not moving?'
			await page.getByRole('textbox').last().fill(message)
			await page.keyboard.press('Enter')
			await expect(page.getByText(message)).toBeVisible({ timeout: 10_000 })

			await page.reload()
			await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('data-state', 'active')
			await expect(page.getByText(message)).toBeVisible({ timeout: 10_000 })
		})
	}
})
