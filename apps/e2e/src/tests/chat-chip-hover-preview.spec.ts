import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

async function openChatWithChip(account: { workspaceId: string; api: TestAPI }, page: Page) {
	const ws = account.workspaceId
	const agent = await account.api.createAgentActor(`Preview QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(ws, agent.id)
	const task = await account.api.createObject(ws, {
		type: 'task',
		title: 'Draw the preview',
		status: 'todo',
		content: 'The preview is the same card, opened under the chip.',
		driver: agent.id,
	})
	const conversation = await account.api.createConversation(ws, {
		title: 'E2E chip preview',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
		content: `See [Draw the preview](/${ws}/objects/${task.id}) when you have a minute.`,
	})
	await page.goto(`/${ws}/chats/${conversation.id}`)
	const thread = page.getByTestId('thread-messages')
	const chip = thread.getByRole('link', { name: /^Task, To do: Draw the preview/ })
	await expect(chip).toBeVisible({ timeout: 10_000 })
	return { thread, chip, ws, task }
}

test.describe('Chat — a chip opens the object card as a preview', () => {
	test('desktop 1440: hover and focus open it under the chip, Escape and leaving close it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })
		const { chip } = await openChatWithChip(account, page)
		const preview = page.locator('[data-linked-preview]')

		await expect(preview).toHaveCount(0)
		await chip.hover()
		await expect(preview).toBeVisible()
		await expect(preview).toContainText('Draw the preview')
		await expect(preview).toContainText('The preview is the same card')

		// Under the chip's left edge, inside the viewport, and the chip's own link stays uncovered.
		const chipBox = await chip.boundingBox()
		const previewBox = await preview.boundingBox()
		expect(previewBox?.y ?? 0).toBeGreaterThanOrEqual((chipBox?.y ?? 0) + (chipBox?.height ?? 0))
		expect(Math.abs((previewBox?.x ?? 0) - (chipBox?.x ?? 0))).toBeLessThanOrEqual(1)
		expect(previewBox?.width ?? 0).toBeLessThanOrEqual(380)
		expect((previewBox?.x ?? 0) + (previewBox?.width ?? 0)).toBeLessThanOrEqual(
			VIEWPORTS.desktop.width,
		)
		await page.screenshot({ path: 'test-results/chip-preview-1440.png' })

		await page.keyboard.press('Escape')
		await expect(preview).toHaveCount(0)

		await page.mouse.move(5, 5)
		await chip.focus()
		await expect(preview).toBeVisible()
		await page.keyboard.press('Tab')
		await expect(preview).toHaveCount(0)
	})

	test('700 wide: a chip near the right edge opens the preview flipped to its right edge, light and dark', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 700, height: 900 })
		const { chip } = await openChatWithChip(account, page)
		const preview = page.locator('[data-linked-preview]')

		// Push the chip to the end of a line, as it would sit in a long sentence.
		await chip.evaluate((el) => {
			const holder = el.parentElement as HTMLElement
			const room = document.documentElement.clientWidth - holder.getBoundingClientRect().right
			holder.style.marginLeft = `${Math.max(0, room - 24)}px`
		})

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.evaluate(
				(dark) => document.documentElement.classList.toggle('dark', dark),
				colorScheme === 'dark',
			)
			await chip.hover()
			await expect(preview).toBeVisible()
			const chipBox = await chip.boundingBox()
			const previewBox = await preview.boundingBox()
			const right = (previewBox?.x ?? 0) + (previewBox?.width ?? 0)
			expect(right).toBeLessThanOrEqual(700)
			expect(previewBox?.x ?? 0).toBeGreaterThanOrEqual(0)
			expect(Math.abs(right - ((chipBox?.x ?? 0) + (chipBox?.width ?? 0)))).toBeLessThanOrEqual(1)
			await page.screenshot({ path: `test-results/chip-preview-700-${colorScheme}.png` })
			await page.mouse.move(5, 5)
			await expect(preview).toHaveCount(0)
		}
	})

	for (const width of [640, 1024, 1440]) {
		test(`${width} wide: a chip at the right edge of the thread opens a preview that stays inside the thread pane`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width, height: 900 })
			const { thread, chip } = await openChatWithChip(account, page)
			const preview = page.locator('[data-linked-preview]')

			// Push the chip to the end of a line, as it would sit in a long sentence.
			await chip.evaluate((el) => {
				const holder = el.parentElement as HTMLElement
				const pane = holder.closest('[data-testid="thread-messages"]') as HTMLElement
				const room = pane.getBoundingClientRect().right - holder.getBoundingClientRect().right
				holder.style.marginLeft = `${Math.max(0, room - 48)}px`
			})

			await chip.hover()
			await expect(preview).toBeVisible()
			const paneBox = await thread.boundingBox()
			const previewBox = await preview.boundingBox()
			const left = previewBox?.x ?? 0
			const right = left + (previewBox?.width ?? 0)
			expect(left).toBeGreaterThanOrEqual((paneBox?.x ?? 0) + 8 - 1)
			expect(right).toBeLessThanOrEqual((paneBox?.x ?? 0) + (paneBox?.width ?? 0) - 8 + 1)
			await page.screenshot({ path: `test-results/chip-preview-pane-${width}.png` })
		})
	}

	test('mobile 375: no hover preview, and a tap opens the sheet instead of the object', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		const { chip, ws, task } = await openChatWithChip(account, page)
		const preview = page.locator('[data-linked-preview]')
		const chatUrl = page.url()

		await chip.hover()
		await chip.focus()
		await expect(preview).toHaveCount(0)
		await chip.click()
		await expect(page.getByRole('dialog', { name: 'Object preview' })).toBeVisible()
		await expect(page).toHaveURL(chatUrl)
		await page.getByRole('link', { name: 'Open' }).click()
		await expect(page).toHaveURL(new RegExp(`/${ws}/objects/${task.id}`))
	})
})
