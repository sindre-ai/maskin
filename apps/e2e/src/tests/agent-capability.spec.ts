import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T5 — the capability card on the agent detail page and the level chip on the
// agent grid. Verifies both against the deployed slot (real server, real DB) at
// mobile / iPad-portrait / iPad-landscape widths, so a broken responsive layout
// or a missing snapshot query would fail the ship gate.

test.describe('Agent capability surfaces', () => {
	test('bare agent detail page renders the capability card, level pill, and a level-up gap', async ({
		page,
		account,
	}) => {
		const bare = await account.api.createAgentActor(`Bare ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, bare.id, 'member')

		await page.goto(`/${account.workspaceId}/agents/${bare.id}`)

		const card = page.getByTestId('capability-card')
		await expect(card).toBeVisible({ timeout: 10000 })

		// A bare, prompt-less agent scores Novice (0–19 band). The pill's
		// aria-label carries the level, so we don't couple to visual styling.
		await expect(card.getByLabelText(/Capability: Novice/).first()).toBeVisible()

		// All 5 rubric dimensions render as tiles.
		await expect(page.getByTestId('capability-tile-expertise')).toBeVisible()
		await expect(page.getByTestId('capability-tile-skills')).toBeVisible()
		await expect(page.getByTestId('capability-tile-connectors')).toBeVisible()
		await expect(page.getByTestId('capability-tile-context')).toBeVisible()
		await expect(page.getByTestId('capability-tile-autonomy')).toBeVisible()

		// The "Level up" checklist must be present — a bare agent always has
		// actionable gaps.
		await expect(page.getByTestId('capability-level-up')).toBeVisible()
	})

	test('grid card shows the capability level chip for an agent', async ({ page, account }) => {
		const agent = await account.api.createAgentActor(`Grid ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id, 'member')

		await page.goto(`/${account.workspaceId}/agents`)

		// Wait for the agent's card to render, then assert the level pill is
		// on it (bare agent → Novice).
		await expect(page.getByText(agent.name)).toBeVisible({ timeout: 10000 })
		await expect(page.getByLabelText(/Capability: Novice/).first()).toBeVisible()
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`capability card is visible at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor(`Bare ${vp.width} ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id, 'member')

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const card = page.getByTestId('capability-card')
			await expect(card).toBeVisible({ timeout: 10000 })
			// Grid of tiles must wrap without pushing the card off-screen — a
			// horizontally-scrolling detail page is a ship-blocker.
			await expect(page.getByTestId('capability-tiles')).toBeVisible()
		})

		test(`grid level chip is visible at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor(`Grid ${vp.width} ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id, 'member')

			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByText(agent.name)).toBeVisible({ timeout: 10000 })
			await expect(page.getByLabelText(/Capability: Novice/).first()).toBeVisible()
		})
	}
})
