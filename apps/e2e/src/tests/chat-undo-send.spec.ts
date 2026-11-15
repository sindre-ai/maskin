import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Undo send in chat (flag chat-undo-send, switched on here through the test-only localStorage
 * override). A sent message is held in the browser for 5 seconds behind an Undo bar: nothing
 * reaches the server until the window ends, and Undo puts the text back in the box.
 */

async function setUpConversation(api: TestAPI, workspaceId: string) {
	const agent = await api.createAgentActor(`E2E Undo Agent ${Date.now()}`)
	await api.addWorkspaceMember(workspaceId, agent.id)
	return api.createConversation(workspaceId, {
		title: 'E2E undo send',
		participant_actor_ids: [agent.id],
	})
}

async function sentCount(api: TestAPI, conversationId: string, workspaceId: string) {
	const { messages } = await api.listConversationMessages(conversationId, workspaceId)
	return messages.length
}

for (const richText of [false, true]) {
	test.describe(`Undo send (formatting box ${richText ? 'on' : 'off'})`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((rich) => {
				localStorage.setItem('ff:chat-undo-send', 'on')
				localStorage.setItem('ff:chat-formatting', rich ? 'on' : 'off')
			}, richText)
		})

		test('Undo takes the message back into the box and nothing is sent', async ({
			page,
			account,
		}) => {
			const conversation = await setUpConversation(account.api, account.workspaceId)
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByLabel('Message this conversation')
			await expect(box).toBeVisible({ timeout: 15_000 })
			await box.click()
			await page.keyboard.type('take this back')
			await box.press('Enter')

			const undo = page.locator('output').getByRole('button', { name: 'Undo' })
			await expect(undo).toBeVisible()
			await page.screenshot({ path: `test-results/undo-send-bar-rich-${richText}.png` })
			await expect(box).toHaveText('')
			expect(await sentCount(account.api, conversation.id, account.workspaceId)).toBe(0)

			await undo.click()
			await expect(undo).toBeHidden()
			await expect(box).toContainText('take this back')

			// Past the window: still nothing posted.
			await page.waitForTimeout(6_000)
			expect(await sentCount(account.api, conversation.id, account.workspaceId)).toBe(0)
		})

		test('with no Undo the message goes out after the window', async ({ page, account }) => {
			const conversation = await setUpConversation(account.api, account.workspaceId)
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByLabel('Message this conversation')
			await expect(box).toBeVisible({ timeout: 15_000 })
			await box.click()
			await page.keyboard.type('let this go')
			await box.press('Enter')

			await expect(page.locator('output').getByRole('button', { name: 'Undo' })).toBeVisible()
			expect(await sentCount(account.api, conversation.id, account.workspaceId)).toBe(0)
			await expect
				.poll(() => sentCount(account.api, conversation.id, account.workspaceId), {
					timeout: 10_000,
				})
				.toBe(1)
			await expect(page.locator('output').getByRole('button', { name: 'Undo' })).toBeHidden()
		})
	})
}

test.describe('Undo send flag off', () => {
	test('a send posts at once', async ({ page, account }) => {
		const conversation = await setUpConversation(account.api, account.workspaceId)
		await page.addInitScript(() => localStorage.setItem('ff:chat-undo-send', 'off'))
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const box = page.getByLabel('Message this conversation')
		await expect(box).toBeVisible({ timeout: 15_000 })
		await box.click()
		await page.keyboard.type('straight away')
		await box.press('Enter')
		await expect
			.poll(() => sentCount(account.api, conversation.id, account.workspaceId), {
				timeout: 5_000,
			})
			.toBe(1)
		await expect(page.locator('output').getByRole('button', { name: 'Undo' })).toHaveCount(0)
	})
})

test.describe('Undo send at phone and tablet widths', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the Undo bar fits and works at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.addInitScript(() => localStorage.setItem('ff:chat-undo-send', 'on'))
			const conversation = await setUpConversation(account.api, account.workspaceId)
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const box = page.getByLabel('Message this conversation')
			await expect(box).toBeVisible({ timeout: 15_000 })
			await box.click()
			await page.keyboard.type('small screen')
			await page.getByRole('button', { name: 'Send message' }).click()

			const undo = page.locator('output').getByRole('button', { name: 'Undo' })
			await expect(undo).toBeVisible()
			const rect = await undo.boundingBox()
			expect(rect).not.toBeNull()
			expect(rect && rect.x >= 0 && rect.x + rect.width <= viewport.width).toBe(true)
			await page.screenshot({ path: `test-results/undo-send-bar-${viewport.width}.png` })

			await undo.click()
			await expect(box).toContainText('small screen')
			expect(await sentCount(account.api, conversation.id, account.workspaceId)).toBe(0)
		})
	}
})

test.describe('Undo send on the new-chat page', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:chat-undo-send', 'on'))
	})

	// Counts the create-conversation requests the page makes (POST only; the list is a GET).
	function countCreates(page: import('@playwright/test').Page) {
		const state = { count: 0 }
		page.on('request', (req) => {
			if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/conversations') {
				state.count += 1
			}
		})
		return state
	}

	test('the first message is held: no chat is created, Undo puts the text back', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor(`E2E Undo New ${Date.now()}`)
		const creates = countCreates(page)
		await page.goto(`/${account.workspaceId}/chats/new?agentId=${agent.id}`)
		const input = page.getByLabel('First message')
		await expect(input).toBeVisible({ timeout: 15_000 })
		await input.fill('hold my first message')
		await input.press('Enter')

		const undo = page.locator('output').getByRole('button', { name: 'Undo' })
		await expect(undo).toBeVisible()
		await expect(input).toHaveValue('')
		await page.screenshot({ path: 'test-results/undo-send-new-chat-held.png' })

		await undo.click()
		await expect(undo).toBeHidden()
		await expect(input).toHaveValue('hold my first message')
		// Past the window: still no chat, and still on the new-chat page.
		await page.waitForTimeout(6_000)
		expect(creates.count).toBe(0)
		await expect(page).toHaveURL(/\/chats\/new/)
	})

	test('a second send while the first is held is refused and keeps its text', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor(`E2E Undo Twice ${Date.now()}`)
		const creates = countCreates(page)
		await page.goto(`/${account.workspaceId}/chats/new?agentId=${agent.id}`)
		const input = page.getByLabel('First message')
		await expect(input).toBeVisible({ timeout: 15_000 })
		await input.fill('first one')
		await input.press('Enter')
		await expect(page.locator('output').getByRole('button', { name: 'Undo' })).toBeVisible()

		await input.fill('second one')
		await input.press('Enter')
		await expect(page.getByText('Undo your first message, or wait for it to send')).toBeVisible()
		await expect(input).toHaveValue('second one')
		expect(creates.count).toBe(0)

		// The window ends: exactly one chat is created, from the first message, and the page opens it.
		await expect(page).toHaveURL(/\/chats\/(?!new)[^/]+$/, { timeout: 15_000 })
		expect(creates.count).toBe(1)
	})
})
