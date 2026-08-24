import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — bottom composer', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		// Mockup 2506–2516: "Message {name}…", which the mockup annotates as
		// starting a new session.
		test(`messages the agent and starts a session @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Cass Composer')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// A real POST would try to launch a container, which the web stack in CI
			// has no runtime for — fulfil it so the wiring is still exercised
			// end-to-end through the UI.
			let createdPrompt: string | null = null
			await page.route('**/api/sessions', async (route) => {
				if (route.request().method() !== 'POST') {
					await route.fallback()
					return
				}
				const body = route.request().postDataJSON() as {
					actor_id: string
					action_prompt: string
				}
				createdPrompt = body.action_prompt
				await route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({
						id: 'sess-new',
						workspaceId: account.workspaceId,
						actorId: body.actor_id,
						triggerId: null,
						status: 'pending',
						containerId: null,
						actionPrompt: body.action_prompt,
						config: null,
						result: null,
						snapshotPath: null,
						startedAt: null,
						completedAt: null,
						timeoutAt: null,
						createdBy: body.actor_id,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
						currentActivity: null,
					}),
				})
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const composer = page.getByTestId('agent-composer')
			await expect(composer).toBeVisible({ timeout: 10_000 })

			// Reachable on touch and legible in both colour schemes.
			const input = composer.getByLabel('Message Cass Composer')
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(input).toBeVisible()
				await expect(composer.getByText('Starts a new session')).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			await input.fill('Sweep the backlog before standup')
			await composer.getByRole('button', { name: 'Send message' }).click()

			await expect(page.getByText(/picked it up/)).toBeVisible()
			expect(createdPrompt).toBe('Sweep the backlog before standup')
			// The composer clears so the next message starts from empty.
			await expect(input).toHaveValue('')
		})
	}
})
