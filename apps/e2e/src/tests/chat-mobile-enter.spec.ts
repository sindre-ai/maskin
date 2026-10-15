import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Regression pin for the mobile-Enter-sends bug (Magnus, #maskin-app).
 *
 * The composer's keydown handler sends on a bare Enter and only inserts a
 * newline on Shift+Enter. A phone soft keyboard has no Shift key, so plain
 * Enter is the ONLY Enter a mobile user can type — it could never produce a
 * newline, and always sent the message instead.
 *
 * The fix reads `useIsMobile()` and, on touch viewports, returns before the
 * send branch so the browser inserts the newline; the visible send button
 * becomes the send affordance there. Desktop (>= 768px) keeps Enter-to-send.
 *
 * This spec drives the real keyboard path at each ship-gate viewport and
 * asserts the outcome on the composer value: a newline insert leaves the text
 * in place, a send clears it. Pressing the send button afterwards proves the
 * mobile composer is still sendable — the fix must not strand the message.
 */

async function setUpConversation(api: TestAPI, workspaceId: string) {
	const agent = await api.createAgentActor(`E2E Mobile Enter Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)

	const conversation = await api.createConversation(workspaceId, {
		title: 'E2E mobile enter',
		participant_actor_ids: [agent.id],
	})

	return { conversation }
}

const TEXT = 'first line of a mobile message'

test.describe('Enter in the chat composer respects the viewport', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		const isTouch = vp.width < 768

		test(`Enter ${isTouch ? 'inserts a newline' : 'sends'} at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const { conversation } = await setUpConversation(account.api, account.workspaceId)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByRole('heading', { name: 'E2E mobile enter' })).toBeVisible({
				timeout: 10_000,
			})

			const composer = page.getByLabel('Message this conversation')
			await expect(composer).toBeVisible()
			await composer.fill(TEXT)
			await expect(composer).toHaveValue(TEXT)

			await composer.press('Enter')

			if (isTouch) {
				// The newline is inserted and the message is NOT sent: a send
				// would have cleared the composer, so retaining the text is the
				// proof. Asserting the trailing newline too pins that the
				// keypress reached the textarea rather than being swallowed.
				await expect(composer).toHaveValue(`${TEXT}\n`)

				// The send affordance still works on mobile — the fix changes
				// which gesture sends, not whether sending is possible.
				await page.getByRole('button', { name: 'Send message' }).click()
				await expect(composer).toHaveValue('')
			} else {
				// Desktop keeps Enter-to-send: the composer clears.
				await expect(composer).toHaveValue('')
			}
		})
	}
})
