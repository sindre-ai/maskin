import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The Chats list folds each agent's chats into one row, with an Agents / Recent switch under the
// title. Every agent also has its direct message, so the agent with two topic chats holds three; the
// other agent has only its direct message and a chat with both agents belongs to neither, so both
// are plain rows.
test.describe('Chats list — one row per agent', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`folds, unfolds and switches to Recent at ${vp.width}px`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const folded = await account.api.createAgentActor(`Fold Agent ${Date.now()}`)
			const solo = await account.api.createAgentActor(`Solo Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, folded.id)
			await account.api.addWorkspaceMember(ws, solo.id)
			for (const title of ['Fold topic one', 'Fold topic two']) {
				await account.api.createConversation(ws, { title, participant_actor_ids: [folded.id] })
			}
			await account.api.createConversation(ws, {
				title: 'Group topic',
				participant_actor_ids: [folded.id, solo.id],
			})

			await page.goto(`/${ws}/chats`)
			const list = page.getByTestId('conversation-list')

			// The agent with several chats is one row; its chats stay folded until the chevron opens them.
			const agentRow = list.getByTestId('agent-row')
			await expect(agentRow).toHaveCount(1)
			await expect(agentRow).toContainText(folded.name)
			await expect(agentRow).toContainText('3 chats')
			await expect(list.getByText('Fold topic one', { exact: true })).toHaveCount(0)
			// A chat with both agents is a plain row.
			await expect(list.getByText('Group topic', { exact: true })).toBeVisible()

			await agentRow.getByRole('button', { name: /Unfold 3 chats/ }).click()
			await expect(list.getByText('Fold topic one', { exact: true })).toBeVisible()
			await expect(list.getByText('Fold topic two', { exact: true })).toBeVisible()

			// The page never scrolls sideways.
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
				),
			).toBe(true)

			// Recent is the flat list, and the choice survives a reload.
			await page.getByRole('tab', { name: 'Recent' }).click()
			await expect(list.getByTestId('agent-row')).toHaveCount(0)
			await expect(list.getByText('Fold topic one', { exact: true })).toBeVisible()
			await page.reload()
			await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute(
				'aria-selected',
				'true',
			)
			await expect(page.getByTestId('conversation-list').getByTestId('agent-row')).toHaveCount(0)
		})
	}
})
