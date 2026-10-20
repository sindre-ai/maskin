import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Comments on an object are written in its group chat. The bar at the bottom of the object page
// opens that chat; the chat opens with the object's earlier comments and is the same chat every
// time. Runs against a backend that has conversation subjects.

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Object group chat at ${vp.label}`, () => {
		test('opens the object chat with its comments as history, and the same chat again', async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const TITLE = `Chat bet ${vp.width}`
			const COMMENT = `History comment ${vp.width}`
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
			})
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: COMMENT,
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 15000,
			})

			const chatEntry = page.getByRole('button', { name: 'Chat about this' })
			await expect(chatEntry).toBeVisible()
			await chatEntry.click()

			await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}/, { timeout: 15000 })
			const chatUrl = page.url()
			await expect(page.getByTestId('thread-messages').getByText(COMMENT)).toBeVisible({
				timeout: 15000,
			})

			// No horizontal page scroll at this ship-gate viewport.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			// Opening it again lands in the same chat, not a second one.
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await page.getByRole('button', { name: 'Chat about this' }).click()
			await expect(page).toHaveURL(chatUrl, { timeout: 15000 })
		})
	})
}
