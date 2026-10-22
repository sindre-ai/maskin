import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const NOTE = 'Hej Catja, tillykke med fusionen. Hvordan bruger I AI-agenter i hverdagen?'

/** A conversation with one message from a second agent: only the non-own branch of MessageBubble draws cards. */
async function chatWithAgentMessage(
	account: { api: TestAPI; workspaceId: string },
	content: (workspaceId: string) => string,
) {
	const agent = await account.api.createAgentActor(`Preview QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E linked object preview',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
		content: content(account.workspaceId),
	})
	return conversation
}

test.describe('Chat — a message that links to a draft shows what the draft says', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the linked draft's title and text appear under the message at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// A draft an integration can deliver (it carries a `metadata.kind`) gets a card.
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'LinkedIn note to Catja',
				status: 'todo',
				content: NOTE,
				metadata: { kind: 'linkedin_message', to: 'Catja' },
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [note](/${ws}/objects/${task.id}) for approval.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			// The card starts collapsed: the title and Open link, then the text once expanded.
			await expect(thread.getByText('LinkedIn note to Catja', { exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByRole('link', { name: 'Open' })).toBeVisible()
			await thread.getByRole('button', { name: 'Expand preview' }).click()
			await expect(thread.getByText(NOTE)).toBeVisible()

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByText(NOTE)).toBeVisible()
			}
		})

		test(`a contact the message links to stays a link, with no card at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const contact = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Catja Nielsen',
				status: 'new',
				content: 'Head of operations at the merged company.',
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Talk to [Catja Nielsen](/${ws}/objects/${contact.id}) first.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByRole('link', { name: 'Catja Nielsen' })).toBeVisible({
				timeout: 10_000,
			})
			// Give a card time to appear if one were going to.
			await page.waitForTimeout(500)
			await expect(thread.getByRole('button', { name: 'Expand preview' })).toHaveCount(0)
			await expect(thread.getByText('Head of operations at the merged company.')).toHaveCount(0)
		})
	}
})
