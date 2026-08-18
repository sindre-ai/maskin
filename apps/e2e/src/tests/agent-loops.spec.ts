import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// "Loops it runs" (mockup 2469–2478) is the agent's only outbound link to its
// work. A loop's agents are derived from its `metadata.trigger_ids` → each
// trigger's target actor, so the seed below has to build both halves.

test.describe('Agent detail — Loops it runs', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`lists the loops the agent runs and links through @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Lena Looper')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback loop',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Nightly sweep',
				type: 'cron',
				action_prompt: 'Sweep the feedback queue',
				target_actor_id: agent.id,
				config: { schedule: '0 3 * * *' },
			})
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id] },
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const section = page.getByRole('region', { name: 'Loops it runs' })
			await expect(section).toBeVisible({ timeout: 10_000 })
			const row = section.getByRole('link', { name: /Customer feedback loop/ })
			await expect(row).toBeVisible()

			// The section inherits LoopRow's pill colours — legible in both schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(row).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			await row.click()
			await expect(page).toHaveURL(new RegExp(`/loops/${loop.id}$`))
		})

		test(`shows the empty state for an agent with no loops @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Solo Sam')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const section = page.getByRole('region', { name: 'Loops it runs' })
			await expect(section).toBeVisible({ timeout: 10_000 })
			await expect(section.getByText('Not tied to a loop yet')).toBeVisible()
		})
	}
})
