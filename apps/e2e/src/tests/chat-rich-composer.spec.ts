import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'

/**
 * The chat message box with formatting (flag chat-rich-composer, switched on here through the
 * test-only localStorage override). Typing markdown or using the shortcuts formats the text, a
 * tag stays a chip, Enter sends, and what reaches the server is the markdown.
 */

async function setUpConversation(api: TestAPI, workspaceId: string) {
	const agent = await api.createAgentActor(`E2E Rich Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)
	const conversation = await api.createConversation(workspaceId, {
		title: 'E2E rich composer',
		participant_actor_ids: [agent.id],
	})
	return { conversation, agent }
}

async function lastSent(api: TestAPI, conversationId: string, workspaceId: string) {
	const { messages } = await api.listConversationMessages(conversationId, workspaceId)
	return messages[0]
}

test.describe('Chat message box with formatting', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:chat-rich-composer', 'on'))
	})

	test('formats with markdown typing and shortcuts, then sends markdown', async ({
		page,
		account,
	}) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()

		await page.keyboard.type('plain ')
		await page.keyboard.press('ControlOrMeta+b')
		await page.keyboard.type('bold')
		await page.keyboard.press('ControlOrMeta+b')
		await page.keyboard.type(' and ')
		await page.keyboard.press('ControlOrMeta+i')
		await page.keyboard.type('italic')
		await page.keyboard.press('ControlOrMeta+i')
		await page.keyboard.type(' and `code` ')
		await expect(box.locator('strong')).toHaveText('bold')
		await expect(box.locator('em')).toHaveText('italic')
		await expect(box.locator('code')).toHaveText('code')
		await page.screenshot({ path: 'test-results/rich-composer-formatted.png' })

		await box.press('Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('**bold**')
		const sent = await lastSent(account.api, conversation.id, account.workspaceId)
		expect(sent?.content).toContain('*italic*')
		expect(sent?.content).toContain('`code`')
		// The box is empty again after the send.
		await expect(box).toHaveText('')
	})

	test('lists and quotes: Enter continues the list, the last Enter sends', async ({
		page,
		account,
	}) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()

		await page.keyboard.type('- one')
		await page.keyboard.press('Enter')
		await page.keyboard.type('two')
		await expect(box.locator('ul > li')).toHaveCount(2)
		// Nothing was sent by the Enter inside the list.
		expect(
			(await account.api.listConversationMessages(conversation.id, account.workspaceId)).messages,
		).toHaveLength(0)
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toMatch(/- one\n- two/)

		await box.click()
		await page.keyboard.type('> quoted')
		await expect(box.locator('blockquote')).toHaveCount(1)
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('> quoted')
	})

	test('Shift+Enter makes a new line and Enter sends it as one message', async ({
		page,
		account,
	}) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.type('line one')
		await page.keyboard.press('Shift+Enter')
		await page.keyboard.type('line two')
		await page.keyboard.press('Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toBe('line one\nline two')
	})

	test('a tag is a chip in the sentence and its id is sent', async ({ page, account }) => {
		const { conversation, agent } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.type('hey @E2E')
		const option = page.getByRole('option', { name: /E2E Rich Agent/ }).first()
		await expect(option).toBeVisible({ timeout: 10_000 })
		await option.click()
		await expect(box.locator('[data-composer-tag]')).toHaveCount(1)
		await page.keyboard.type('please look')
		await page.screenshot({ path: 'test-results/rich-composer-tag.png' })
		await box.press('Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('@E2E Rich Agent')
		const sent = await lastSent(account.api, conversation.id, account.workspaceId)
		expect(JSON.stringify(sent?.metadata ?? {})).toContain(agent.id)
	})

	test('a table copied from a sheet arrives as a markdown table', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await box.evaluate((el) => {
			const data = new DataTransfer()
			data.setData(
				'text/html',
				'<table><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Apples</td><td>3</td></tr></tbody></table>',
			)
			data.setData('text/plain', 'Name\tQty\nApples\t3')
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
			)
		})
		await expect(box.locator('table')).toHaveCount(1)
		await page.screenshot({ path: 'test-results/rich-composer-table.png' })
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('| Name | Qty |')
		const sent = await lastSent(account.api, conversation.id, account.workspaceId)
		expect(sent?.content).toContain('| --- | --- |')
		expect(sent?.content).toContain('| Apples | 3 |')
	})

	test('a draft with formatting and a tag comes back after a reload', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.press('ControlOrMeta+b')
		await page.keyboard.type('keep me')
		await page.keyboard.press('ControlOrMeta+b')
		await page.keyboard.type(' @E2E')
		await page
			.getByRole('option', { name: /E2E Rich Agent/ })
			.first()
			.click()
		await page.reload()
		const restored = page.getByLabel('Message this conversation')
		await expect(restored.locator('strong')).toHaveText('keep me', { timeout: 15_000 })
		await expect(restored.locator('[data-composer-tag]')).toHaveCount(1)
	})

	test('on a phone Enter inserts a new line and the send button sends', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 700 })
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()
		await page.keyboard.type('first')
		await page.keyboard.press('Enter')
		await page.keyboard.type('second')
		expect(
			(await account.api.listConversationMessages(conversation.id, account.workspaceId)).messages,
		).toHaveLength(0)
		await page.screenshot({ path: 'test-results/rich-composer-mobile.png' })
		await page.getByRole('button', { name: 'Send message' }).click()
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('second')
	})

	test('markdown as you type: stars, a dash and a number format live', async ({
		page,
		account,
	}) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.type('**word** and *soft* ')
		await expect(box.locator('strong')).toHaveText('word')
		await expect(box.locator('em')).toHaveText('soft')
		await page.keyboard.press('Shift+Enter')
		await page.keyboard.press('Shift+Enter')
		await page.keyboard.type('- bullet')
		await expect(box.locator('ul > li')).toHaveCount(1)
		await page.keyboard.press('Enter')
		await page.keyboard.press('Enter')
		await page.keyboard.type('1. first')
		await expect(box.locator('ol > li')).toHaveCount(1)
		await page.screenshot({ path: 'test-results/rich-composer-typing.png' })
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toContain('**word**')
		const sent = await lastSent(account.api, conversation.id, account.workspaceId)
		expect(sent?.content).toContain('*soft*')
		expect(sent?.content).toMatch(/^- bullet/m)
		expect(sent?.content).toMatch(/^1\. first/m)
	})

	test('pasting a link over selected text makes the text the link', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.type('this is a Link')
		await page.keyboard.press('Shift+ControlOrMeta+ArrowLeft')
		await box.evaluate((el) => {
			const data = new DataTransfer()
			data.setData('text/plain', 'https://example.com/docs')
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
			)
		})
		await expect(box.locator('a')).toHaveText('Link')
		await expect(box.locator('a')).toHaveAttribute('href', 'https://example.com/docs')
		await page.screenshot({ path: 'test-results/rich-composer-paste-link.png' })
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toBe('this is a [Link](https://example.com/docs)')
	})

	test('pasting a link with nothing selected stays as it is', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.keyboard.type('see ')
		await box.evaluate((el) => {
			const data = new DataTransfer()
			data.setData('text/plain', 'https://example.com/docs')
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
			)
		})
		await expect(box).toContainText('https://example.com/docs')
	})

	test('Show formatting opens a row of buttons that act on the selection', async ({
		page,
		account,
	}) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		// Hidden until asked for.
		await expect(page.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0)
		await page.getByRole('button', { name: 'Attach file' }).click()
		await page.getByRole('menuitem', { name: 'Show formatting' }).click()
		const bar = page.getByRole('toolbar', { name: 'Formatting' })
		await expect(bar).toBeVisible()
		for (const name of [
			'Bold',
			'Italic',
			'Strikethrough',
			'Link',
			'Bulleted list',
			'Numbered list',
			'Quote',
			'Inline code',
			'Code block',
		]) {
			await expect(bar.getByRole('button', { name })).toBeVisible()
		}

		await box.click()
		await page.keyboard.type('make bold')
		await page.keyboard.press('Shift+ControlOrMeta+ArrowLeft')
		await bar.getByRole('button', { name: 'Bold' }).click()
		await expect(box.locator('strong')).toHaveText('bold')
		await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
		await page.screenshot({ path: 'test-results/rich-composer-format-row.png' })
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toBe('make **bold**')

		// The choice is remembered for this person: the row is open after a reload.
		await page.reload()
		await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible({
			timeout: 15_000,
		})
		await page.getByRole('button', { name: 'Attach file' }).click()
		await expect(page.getByRole('menuitem', { name: 'Hide formatting' })).toBeVisible()
	})

	test('the Link button wraps the selection in the address typed', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await box.click()
		await page.getByRole('button', { name: 'Attach file' }).click()
		await page.getByRole('menuitem', { name: 'Show formatting' }).click()
		await box.click()
		await page.keyboard.type('read the docs')
		await page.keyboard.press('Shift+ControlOrMeta+ArrowLeft')
		await page
			.getByRole('toolbar', { name: 'Formatting' })
			.getByRole('button', { name: 'Link' })
			.click()
		await page.getByLabel('Link address').fill('example.com/docs')
		await page.getByRole('button', { name: 'Apply' }).click()
		await expect(box.locator('a')).toHaveAttribute('href', 'https://example.com/docs')
		await page.keyboard.press('ControlOrMeta+Enter')
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toBe('read the [docs](https://example.com/docs)')
	})

	test('the format row works at phone width', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 700 })
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await page.getByRole('button', { name: 'Attach file' }).click()
		await page.getByRole('menuitem', { name: 'Show formatting' }).click()
		const bar = page.getByRole('toolbar', { name: 'Formatting' })
		await expect(bar).toBeVisible()
		await box.click()
		await page.keyboard.type('tap bold')
		await page.keyboard.press('Shift+ControlOrMeta+ArrowLeft')
		await bar.getByRole('button', { name: 'Bold' }).click()
		await expect(box.locator('strong')).toHaveText('bold')
		await page.screenshot({ path: 'test-results/rich-composer-format-row-mobile.png' })
		await page.getByRole('button', { name: 'Send message' }).click()
		await expect
			.poll(
				async () => (await lastSent(account.api, conversation.id, account.workspaceId))?.content,
			)
			.toBe('tap **bold**')
	})

	test('the new-chat page has the same box', async ({ page, account }) => {
		await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/new`)
		const box = page.getByLabel('First message')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()
		await page.keyboard.press('ControlOrMeta+b')
		await page.keyboard.type('hello')
		await expect(box.locator('strong')).toHaveText('hello')
		await page.screenshot({ path: 'test-results/rich-composer-new-chat.png' })
	})
})

test.describe('Flag off', () => {
	test('the plain box stays: no editor, a textarea', async ({ page, account }) => {
		const { conversation } = await setUpConversation(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByLabel('Message this conversation')).toBeVisible({ timeout: 15_000 })
		await expect(page.locator('.ProseMirror')).toHaveCount(0)
	})
})
