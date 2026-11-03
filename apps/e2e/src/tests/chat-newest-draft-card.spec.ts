import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const WIDTHS = [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]

test.describe('Chat — a revised draft linked again holds the full card on the newest message', () => {
	for (const vp of WIDTHS) {
		test(`the newest message holds the revised draft's card, the unchanged one keeps its first card at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId

			const agent = await account.api.createAgentActor(`Newest Draft QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const agentApi = new TestAPI(agent.api_key)
			// A draft an integration can deliver (it carries a `metadata.kind`) gets a card.
			const draft = (title: string, content: string) =>
				account.api.createObject(ws, {
					type: 'task',
					title,
					status: 'todo',
					content,
					metadata: { kind: 'linkedin_message', to: 'Catja' },
				})
			const revised = await draft('Revised note to Catja', 'Hej Catja, første version.')
			const unchanged = await draft('Unchanged note to Torben', 'Hej Torben, dokumenterne.')
			const link = (title: string, id: string) => `[${title}](/${ws}/objects/${id})`

			const conversation = await account.api.createConversation(ws, {
				title: 'E2E newest draft wins',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await agentApi.postConversationMessage(conversation.id, ws, {
				content: `First drafts for you.\n\n${link(revised.title, revised.id)}\n\n${link(unchanged.title, unchanged.id)}`,
			})
			// The agent revises one draft after the first message, then links both again.
			await new Promise((resolve) => setTimeout(resolve, 1_100))
			await agentApi.updateObject(revised.id, ws, { content: 'Hej Catja, anden version.' })
			await new Promise((resolve) => setTimeout(resolve, 1_100))
			await agentApi.postConversationMessage(conversation.id, ws, {
				content: `I changed the first one.\n\n${link(revised.title, revised.id)}\n\n${link(unchanged.title, unchanged.id)}`,
			})

			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			await expect(thread.locator('[data-linked-card]').first()).toBeVisible({ timeout: 10_000 })
			const first = thread.locator('[data-message-id]').filter({ hasText: 'First drafts for you.' })
			const second = thread
				.locator('[data-message-id]')
				.filter({ hasText: 'I changed the first one.' })

			// The revised draft: the card moved to the newest message with an Updated tag, and the
			// first message keeps a chip.
			await expect(
				second.locator('[data-linked-card]').filter({ hasText: revised.title }),
			).toHaveCount(1)
			await expect(second.locator('[data-linked-card-updated]')).toHaveCount(1)
			await expect(
				first.locator('[data-linked-card]').filter({ hasText: revised.title }),
			).toHaveCount(0)
			await expect(first.getByRole('link', { name: new RegExp(revised.title) })).toBeVisible()

			// The unchanged draft: still one card, on the first message, and the later link is a chip.
			await expect(
				first.locator('[data-linked-card]').filter({ hasText: unchanged.title }),
			).toHaveCount(1)
			await expect(
				second.locator('[data-linked-card]').filter({ hasText: unchanged.title }),
			).toHaveCount(0)
			await expect(second.getByRole('link', { name: new RegExp(unchanged.title) })).toBeVisible()
			await expect(thread.locator('[data-linked-card]')).toHaveCount(2)

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}
})
