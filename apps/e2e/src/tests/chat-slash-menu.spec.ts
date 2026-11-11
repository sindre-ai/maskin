import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'

/**
 * The slash menu in the chat message box (flag chat-rich-composer, switched on through the
 * test-only localStorage override). Typing "/" opens a short menu: code block, quote, bulleted
 * list, numbered list, attach a file. Esc closes it and keeps the text.
 */

async function openChat(api: TestAPI, workspaceId: string) {
	const agent = await api.createAgentActor(`E2E Slash Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)
	return api.createConversation(workspaceId, {
		title: 'E2E slash menu',
		participant_actor_ids: [agent.id],
	})
}

test.describe('Chat message box slash menu', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:chat-rich-composer', 'on'))
	})

	test('picks a code block, filters, and Esc keeps the typed text', async ({ page, account }) => {
		const conversation = await openChat(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()

		await page.keyboard.type('/')
		await expect(page.getByRole('option')).toHaveCount(5)
		await page.keyboard.type('quo')
		await expect(page.getByRole('option')).toHaveCount(1)
		await page.keyboard.press('Escape')
		await expect(page.getByRole('option')).toHaveCount(0)
		await expect(box).toContainText('/quo')

		await box.press('ControlOrMeta+a')
		await page.keyboard.press('Backspace')
		await page.keyboard.type('/')
		await page.getByRole('option', { name: /Code block/ }).click()
		await expect(box.locator('pre')).toBeVisible()
	})

	test('Enter picks a row, and a slash path with no match still sends', async ({
		page,
		account,
	}) => {
		const conversation = await openChat(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()

		await page.keyboard.type('/bul')
		await expect(page.getByRole('option')).toHaveCount(1)
		await page.keyboard.press('Enter')
		await page.keyboard.type('one')
		await page.keyboard.press('Enter')
		await page.keyboard.type('two')
		await expect(box.locator('ul li')).toHaveCount(2)
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(async () => {
				const { messages } = await account.api.listConversationMessages(
					conversation.id,
					account.workspaceId,
				)
				return messages[0]?.content
			})
			.toBe('- one\n- two')

		await box.click()
		await page.keyboard.type('see /usr/bin')
		await expect(page.getByRole('option')).toHaveCount(0)
		await page.keyboard.press('Enter')
		await expect
			.poll(async () => {
				const { messages } = await account.api.listConversationMessages(
					conversation.id,
					account.workspaceId,
				)
				return messages[0]?.content
			})
			.toBe('see /usr/bin')
	})

	test('Attach a file opens the file picker', async ({ page, account }) => {
		const conversation = await openChat(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()

		await page.keyboard.type('/file')
		await expect(page.getByRole('option')).toHaveCount(1)
		const chooser = page.waitForEvent('filechooser')
		await page.keyboard.press('Enter')
		await chooser
		await expect(box).not.toContainText('/file')
	})

	test.describe('phone width', () => {
		test.use({ viewport: { width: 390, height: 844 } })

		test('the menu is a bottom sheet and a pick works', async ({ page, account }) => {
			const conversation = await openChat(account.api, account.workspaceId)
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByLabel('Message this conversation')
			await expect(box).toBeVisible({ timeout: 15_000 })
			await box.click()

			await page.keyboard.type('/')
			await page.getByRole('option', { name: /Quote/ }).click()
			await expect(box.locator('blockquote')).toBeVisible()
		})
	})
})
