import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const LINK_TEXT = 'the docs'
const LINK_HREF = 'https://example.com/docs'

const MESSAGE = `See [${LINK_TEXT}](${LINK_HREF}) before you continue.`

test.describe('Chat — clicking a link opens a new tab', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a chat link targets a new tab and does not navigate the current page at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// The link is posted by a SECOND agent actor, never the session actor:
			// MessageBubble forks on isOwn, and only the non-own (markdown) branch
			// renders an anchor. Seeding it as the session actor renders a plain-text
			// bubble with no link in the DOM.
			const agent = await account.api.createAgentActor(`Link QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E chat link target',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(
				conversation.id,
				account.workspaceId,
				{ content: MESSAGE },
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			// Scope to the thread's message list — the composer and other chrome also
			// render on this route.
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })

			const link = thread.getByRole('link', { name: LINK_TEXT })
			await expect(link).toBeVisible({ timeout: 10_000 })
			await expect(link).toHaveAttribute('href', LINK_HREF)
			await expect(link).toHaveAttribute('target', '_blank')
			await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

			// Reachable and legible in both colour schemes — toBeVisible() checks
			// opacity and visibility, so a token that renders the link invisible fails.
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(link).toBeVisible()
			}

			// The click must open a new tab and leave the current page where it was.
			const urlBefore = page.url()
			const popupPromise = page.waitForEvent('popup', { timeout: 10_000 })
			await link.click()
			const popup = await popupPromise
			await popup.close()

			expect(page.url()).toBe(urlBefore)
		})
	}
})
