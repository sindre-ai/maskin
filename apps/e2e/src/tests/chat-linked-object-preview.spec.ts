import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const NOTE = 'Hej Catja, tillykke med fusionen. Hvordan bruger I AI-agenter i hverdagen?'

test.describe('Chat — a message that links to an object shows what the object says', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the linked object's title and text appear under the message at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'LinkedIn note to Catja',
				status: 'todo',
				content: NOTE,
			})

			// Posted by a second agent actor: only the non-own branch of MessageBubble
			// renders previews (see chat-link-new-tab.spec.ts).
			const agent = await account.api.createAgentActor(`Preview QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E linked object preview',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(
				conversation.id,
				account.workspaceId,
				{ content: `Here is the [note](/${account.workspaceId}/objects/${task.id}) for approval.` },
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await expect(thread.getByText(NOTE)).toBeVisible({ timeout: 10_000 })
			await expect(thread.getByText('LinkedIn note to Catja', { exact: true })).toBeVisible()
			await expect(thread.getByRole('link', { name: /Open/ })).toBeVisible()

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByText(NOTE)).toBeVisible()
			}
		})
	}
})
