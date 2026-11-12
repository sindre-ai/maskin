import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The chat list's search box reaches every chat: an archived chat that the list does not hold is
 * found by a word in its messages, marked Archived, and opens with an "Archived. Unarchive" bar
 * whose button puts it back. Real API throughout.
 */

test.describe('Chat list search reaches archived chats', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`finds an archived chat by a message word and unarchives it @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const word = `zebrafish${Date.now()}`
			const agent = await account.api.createAgentActor(`Search QA ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'Old invoice export',
				participant_actor_ids: [agent.id],
				initial_message: `The nightly job logged ${word} twice`,
			})
			await account.api.updateConversationMe(conversation.id, account.workspaceId, {
				archived: true,
			})

			await page.goto(`/${account.workspaceId}/chats`)
			await page.getByRole('searchbox', { name: 'Search chats' }).fill(word)

			const results = page.getByTestId('conversation-search-results')
			await expect(results.getByText('Old invoice export')).toBeVisible()
			await expect(results.getByText('Archived', { exact: true })).toBeVisible()
			await expect(results.locator('mark', { hasText: word })).toBeVisible()

			await results.getByText('Old invoice export').click()
			const bar = page.getByTestId('archived-bar')
			await expect(bar).toBeVisible()
			await bar.getByRole('button', { name: 'Unarchive' }).click()
			await expect(bar).toBeHidden()
			await expect
				.poll(async () => {
					const me = await account.api.getConversation(conversation.id, account.workspaceId)
					return me.archived
				})
				.toBe(false)
		})
	}
})
