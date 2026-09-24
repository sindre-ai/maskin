import { expect, test } from '../fixtures/auth.fixture'
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

			// The creator is auto-added to the participant list, so a single-participant
			// conversation is enough — no extra human seat or agent session needed.
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E chat link target',
				participant_actor_ids: [],
			})
			await account.api.postConversationMessage(conversation.id, account.workspaceId, {
				content: MESSAGE,
			})

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
