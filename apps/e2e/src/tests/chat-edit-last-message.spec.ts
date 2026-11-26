import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Chat: the up arrow in an empty message box opens the person's last sent message for editing.
 */

test.describe('Chat, up arrow edits the last message', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`up arrow in the empty box opens the last own message, saving shows the change and the edited mark at ${vp.width}px`, async ({
			page,
			account,
		}, testInfo) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Upagent ${Date.now()}`)
			const conv = await account.api.createConversation(ws, {
				title: 'Up arrow edit',
				participant_actor_ids: [agent.id],
			})
			await account.api.postConversationMessage(conv.id, ws, { content: 'first message' })
			await account.api.postConversationMessage(conv.id, ws, { content: 'second message' })

			await page.goto(`/${ws}/chats/${conv.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByText('second message', { exact: true })).toBeVisible()

			// With text in the box the key does nothing.
			const composer = page.getByRole('textbox', { name: 'Message this conversation' })
			await composer.click()
			await page.keyboard.type('half a thought')
			await page.keyboard.press('ArrowUp')
			await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
			await page.keyboard.press('Control+A')
			await page.keyboard.press('Backspace')

			// Empty box: the newest own message opens, the older one does not.
			await page.keyboard.press('ArrowUp')
			const edit = page.getByRole('textbox', { name: 'Edit message' })
			await expect(edit).toHaveCount(1)
			await expect(edit).toContainText('second message')
			await expect(edit).toBeFocused()
			await testInfo.attach('edit-card-open', {
				body: await page.screenshot({ path: `test-results/edit-last-open-${vp.width}.png` }),
				contentType: 'image/png',
			})

			await page.keyboard.press('End')
			await page.keyboard.type(' (changed)')
			await page.keyboard.press('Enter')
			await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
			await expect(thread.getByText('second message (changed)')).toBeVisible()
			await expect(thread.getByText('(edited)')).toHaveCount(1)
			await testInfo.attach('edit-saved', {
				body: await page.screenshot({ path: `test-results/edit-last-saved-${vp.width}.png` }),
				contentType: 'image/png',
			})
		})
	}

	test('the up arrow also works in the formatting box', async ({ page, account }) => {
		await page.addInitScript(() => localStorage.setItem('ff:chat-formatting', 'on'))
		const ws = account.workspaceId
		const agent = await account.api.createAgentActor(`Upagent ${Date.now()}`)
		const conv = await account.api.createConversation(ws, {
			title: 'Up arrow formatting box',
			participant_actor_ids: [agent.id],
		})
		await account.api.postConversationMessage(conv.id, ws, { content: 'rich first' })

		await page.goto(`/${ws}/chats/${conv.id}`)
		const thread = page.getByTestId('thread-messages')
		await expect(thread.getByText('rich first', { exact: true })).toBeVisible()

		const composer = page.getByRole('textbox', { name: 'Message this conversation' })
		await composer.click()
		await page.keyboard.type('draft')
		await page.keyboard.press('ArrowUp')
		await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
		await page.keyboard.press('Control+A')
		await page.keyboard.press('Backspace')

		await page.keyboard.press('ArrowUp')
		const edit = page.getByRole('textbox', { name: 'Edit message' })
		await expect(edit).toHaveCount(1)
		await expect(edit).toContainText('rich first')
		await expect(edit).toBeFocused()
	})
})
