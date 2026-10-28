import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'

async function openChatWithChip(account: { workspaceId: string; api: TestAPI }, page: Page) {
	const ws = account.workspaceId
	const agent = await account.api.createAgentActor(`Sheet QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(ws, agent.id)
	const task = await account.api.createObject(ws, {
		type: 'task',
		title: 'Draw the sheet',
		status: 'todo',
		content: 'The sheet holds the same card as the preview.',
		driver: agent.id,
	})
	const conversation = await account.api.createConversation(ws, {
		title: 'E2E chip sheet',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
		content: `See [Draw the sheet](/${ws}/objects/${task.id}) when you have a minute.`,
	})
	await page.goto(`/${ws}/chats/${conversation.id}`)
	const thread = page.getByTestId('thread-messages')
	const chip = thread.getByRole('link', { name: /^Task, To do: Draw the sheet/ })
	await expect(chip).toBeVisible({ timeout: 10_000 })
	return { thread, chip, ws, task, chatUrl: page.url() }
}

test.describe('Chat — a tap on a chip on a phone opens a bottom sheet', () => {
	test.use({ hasTouch: true, isMobile: true })

	test('375: the tap opens the sheet and does not navigate; the sheet holds the card, Open, Copy link and Close', async ({
		page,
		account,
		context,
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write'])
		await page.setViewportSize({ width: 375, height: 812 })
		const { chip, ws, task, chatUrl } = await openChatWithChip(account, page)

		await expect(page.getByRole('dialog')).toHaveCount(0)
		await chip.tap()
		const sheet = page.getByRole('dialog', { name: 'Object preview' })
		await expect(sheet).toBeVisible()
		await expect(sheet).toHaveAttribute('aria-modal', 'true')
		await expect(page).toHaveURL(chatUrl)

		// The card is the preview's card, and it is not a link: the only link is Open.
		await expect(sheet).toContainText('Draw the sheet')
		await expect(sheet).toContainText('The sheet holds the same card as the preview.')
		await expect(sheet).toContainText(/to ?do/i)
		await expect(sheet.getByRole('link')).toHaveCount(1)
		const open = sheet.getByRole('link', { name: 'Open' })
		const copy = sheet.getByRole('button', { name: 'Copy link' })
		const close = sheet.getByRole('button', { name: 'Close' })
		const openBox = await open.boundingBox()
		const copyBox = await copy.boundingBox()
		const closeBox = await close.boundingBox()
		expect(openBox?.height).toBe(40)
		expect(copyBox?.width).toBe(40)
		expect(copyBox?.height).toBe(40)
		expect(closeBox?.height).toBe(40)
		await expect(open).toHaveCSS('background-color', /.+/)

		// It sits at the bottom edge of the screen and rises over 300ms; the backdrop fades over 180ms.
		await expect
			.poll(async () => {
				const box = await sheet.boundingBox()
				return Math.round((box?.y ?? 0) + (box?.height ?? 0))
			})
			.toBe(812)
		expect((await sheet.boundingBox())?.width).toBe(375)
		await expect(sheet).toHaveCSS('animation-duration', '0.3s')
		const backdrop = page.locator('[data-state="open"].fixed.inset-0')
		await expect(backdrop).toHaveCSS('animation-duration', '0.18s')
		await page.screenshot({ path: 'test-results/chip-sheet-375-light.png' })
		await page.evaluate(() => document.documentElement.classList.add('dark'))
		await page.screenshot({ path: 'test-results/chip-sheet-375-dark.png' })
		await page.evaluate(() => document.documentElement.classList.remove('dark'))

		// Copy link copies the object's address and shows the toast.
		await copy.tap()
		await expect(page.getByText('Link copied')).toBeVisible()
		expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
			new RegExp(`/${ws}/objects/${task.id}$`),
		)
		await expect(page.getByText('Link copied')).toBeHidden({ timeout: 5_000 })

		// Open goes to the object.
		await open.tap()
		await expect(page).toHaveURL(new RegExp(`/${ws}/objects/${task.id}`))
	})

	test('375: Close, a tap on the backdrop and Escape close it, and focus goes back to the chip', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { chip, chatUrl } = await openChatWithChip(account, page)
		const sheet = page.getByRole('dialog', { name: 'Object preview' })

		await chip.tap()
		await expect(sheet).toBeVisible()
		await sheet.getByRole('button', { name: 'Close' }).tap()
		await expect(sheet).toHaveCount(0)
		await expect(chip).toBeFocused()

		await chip.tap()
		await expect(sheet).toBeVisible()
		await page.touchscreen.tap(187, 40)
		await expect(sheet).toHaveCount(0)
		await expect(chip).toBeFocused()

		await chip.tap()
		await expect(sheet).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(sheet).toHaveCount(0)
		await expect(chip).toBeFocused()
		await expect(page).toHaveURL(chatUrl)
	})

	test('375: focus moves into the sheet and Tab stays inside it', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { chip } = await openChatWithChip(account, page)
		const sheet = page.getByRole('dialog', { name: 'Object preview' })

		await chip.tap()
		await expect(sheet).toBeVisible()
		const insideSheet = () =>
			page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)
		await expect.poll(insideSheet).toBe(true)
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press('Tab')
			expect(await insideSheet()).toBe(true)
		}
		await page.keyboard.press('Shift+Tab')
		expect(await insideSheet()).toBe(true)
	})
})

test.describe('Chat — the sheet and the preview split at 640px', () => {
	test.use({ hasTouch: false })

	test('639: a click opens the sheet; 640: it opens the object and hover previews', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 639, height: 900 })
		const { chip, ws, task, chatUrl } = await openChatWithChip(account, page)
		const sheet = page.getByRole('dialog', { name: 'Object preview' })
		const preview = page.locator('[data-linked-preview]')

		await chip.hover()
		await expect(preview).toHaveCount(0)
		await chip.click()
		await expect(sheet).toBeVisible()
		await expect(page).toHaveURL(chatUrl)
		await page.keyboard.press('Escape')
		await expect(sheet).toHaveCount(0)

		await page.setViewportSize({ width: 640, height: 900 })
		await chip.hover()
		await expect(preview).toBeVisible()
		await page.mouse.move(5, 5)
		await chip.click()
		await expect(sheet).toHaveCount(0)
		await expect(page).toHaveURL(new RegExp(`/${ws}/objects/${task.id}`))
	})

	test('1024 with a pointer: hover previews and a click opens the object', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const { chip, ws, task } = await openChatWithChip(account, page)
		const preview = page.locator('[data-linked-preview]')

		await chip.hover()
		await expect(preview).toBeVisible()
		// It fades in and rises over 180ms.
		await expect(preview).toHaveCSS('animation-duration', '0.18s')
		await chip.click()
		await expect(page.getByRole('dialog', { name: 'Object preview' })).toHaveCount(0)
		await expect(page).toHaveURL(new RegExp(`/${ws}/objects/${task.id}`))
	})
})
