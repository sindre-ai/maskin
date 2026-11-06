import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * v16 composer: one white bar (52 px on desktop), + at the left, ONE round action button on the
 * right that is the mic while the draft is empty and the send arrow once there is text. Touch
 * widths (< 768 px) get 44 px targets. Runs on a thread's composer, the same `Composer` that
 * the agent chats, the briefing viewer and the flow chat share.
 */

const SHOTS = process.env.P1_SHOTS

// The new-chat page is a plain form now, so the composer is read on a conversation's thread.
async function openThread(account: { workspaceId: string; api: TestAPI }) {
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Composer ${Date.now()}`,
		participant_actor_ids: [],
		initial_message: 'A conversation to type into',
	})
	return conversation.id
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	const touch = viewport.width < 768
	const target = touch ? 44 : 40

	for (const scheme of ['light', 'dark'] as const) {
		test.describe(`Composer v16 — ${viewport.label} — ${scheme}`, () => {
			test.use({ viewport: { width: viewport.width, height: viewport.height } })

			test.beforeEach(async ({ page }) => {
				await page.addInitScript((mode: string) => {
					localStorage.setItem('maskin-theme', mode)
				}, scheme)
			})

			test('one bar, + at the left, one action button that swaps mic and send', async ({
				page,
				account,
			}) => {
				await page.goto(`/${account.workspaceId}/chats/${await openThread(account)}`)
				const textbox = page.getByRole('textbox').last()
				await expect(textbox).toBeVisible({ timeout: 10_000 })
				const plus = page.getByRole('button', { name: 'Attach file' })
				await expect(plus).toBeVisible()
				await expect(plus).toBeEnabled()

				// A long placeholder may wrap in a narrow column, so measure the one-line bar.
				await textbox.fill('x')
				// The bar is the form's first box, around the + , the field and the action button:
				// 52 px (4 px padding around 44 px buttons on touch).
				const bar = textbox.locator('xpath=ancestor::form[1]/div[1]')
				const barBox = await bar.boundingBox()
				expect(barBox?.height ?? 0, 'bar height').toBeGreaterThanOrEqual(52)
				expect(barBox?.height ?? 0, 'bar height').toBeLessThanOrEqual(53)

				// + is the first control and sits left of the text.
				const plusBox = await plus.boundingBox()
				const textBox = await textbox.boundingBox()
				expect(plusBox?.width ?? 0).toBeGreaterThanOrEqual(target)
				expect(plusBox?.height ?? 0).toBeGreaterThanOrEqual(target)
				expect((plusBox?.x ?? 0) + (plusBox?.width ?? 0)).toBeLessThanOrEqual(textBox?.x ?? 0)

				const dictate = page.getByRole('button', { name: 'Dictate a message' })
				const send = page.getByRole('button', { name: 'Send message' })

				await textbox.fill('')

				// Empty: exactly one action button (the mic when dictation works here).
				await expect(dictate.or(send)).toHaveCount(1)

				if (SHOTS)
					await page.screenshot({ path: `${SHOTS}/after-empty-${viewport.width}-${scheme}.png` })

				// Typed: the same slot is the send arrow, and it is the only action button.
				await textbox.fill('Hello there')
				await expect(send).toBeVisible()
				await expect(send).toBeEnabled()
				await expect(dictate).toHaveCount(0)
				const sendBox = await send.boundingBox()
				expect(sendBox?.width ?? 0).toBeGreaterThanOrEqual(target)
				expect(sendBox?.height ?? 0).toBeGreaterThanOrEqual(target)
				expect((sendBox?.x ?? 0) + (sendBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
				expect(sendBox?.x ?? 0).toBeGreaterThan((textBox?.x ?? 0) + (textBox?.width ?? 0) - 1)

				if (SHOTS)
					await page.screenshot({ path: `${SHOTS}/after-typed-${viewport.width}-${scheme}.png` })

				// Clearing the draft brings the mic back.
				await textbox.fill('')
				await expect(send).toHaveCount(0)
				await expect(dictate).toBeVisible()
			})

			test('the + menu is reachable and lists Photo, File, Item, Person or agent', async ({
				page,
				account,
			}) => {
				await page.goto(`/${account.workspaceId}/chats/${await openThread(account)}`)
				await expect(page.getByRole('textbox').last()).toBeVisible({ timeout: 10_000 })
				await page.getByRole('button', { name: 'Attach file' }).click()
				for (const name of ['Photo', 'File', 'Item', 'Person or agent']) {
					await expect(page.getByRole('menuitem', { name })).toBeVisible()
				}
				if (SHOTS)
					await page.screenshot({ path: `${SHOTS}/after-menu-${viewport.width}-${scheme}.png` })

				// Person or agent types the @ and the mention picker opens.
				await page.getByRole('menuitem', { name: 'Person or agent' }).click()
				await expect(page.getByRole('textbox').last()).toHaveText('@')
			})
		})
	}
}
