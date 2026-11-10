import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The picture goes into the HTML report as an attachment (apps/e2e/playwright-report, uploaded by
// CI as the playwright-report-N artifact), because test-results/ is not uploaded.
async function picture(page: Page, testInfo: TestInfo, name: string) {
	// Borders, the picker and the chip ease in: wait for every running animation to finish
	// instead of a fixed pause.
	await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
	await testInfo.attach(name, {
		body: await page.screenshot(),
		contentType: 'image/png',
	})
}

test.describe('Chat — reacting to a message', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`the Add reaction button opens a picker, the chip appears, survives a reload and can be taken back at ${vp.width}px in ${scheme}`, async ({
				page,
				account,
			}, testInfo) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				// The app defaults to light; the theme setting is what switches it.
				await page.addInitScript((mode) => localStorage.setItem('maskin-theme', mode), scheme)
				await page.emulateMedia({ colorScheme: scheme })
				const ws = account.workspaceId
				const agent = await account.api.createAgentActor(`Reactor ${Date.now()}`)
				const conv = await account.api.createConversation(ws, {
					title: 'Reactions',
					participant_actor_ids: [agent.id],
				})
				const posted = await account.api.postConversationMessage(conv.id, ws, {
					content: 'Shipping the fix today.',
				})

				await page.goto(`/${ws}/chats/${conv.id}`)

				// The entry point is a visible button in the message's action row, not a hover reveal.
				const add = page.getByRole('button', { name: 'Add reaction' }).first()
				await expect(add).toBeVisible()
				// It is a real touch target: at least 24px square on every viewport.
				const box = await add.boundingBox()
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(20)
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(20)

				await add.click()
				for (const emoji of ['👍', '❤️', '😂', '✅', '👀']) {
					await expect(page.getByRole('button', { name: `React with ${emoji}` })).toBeVisible()
				}
				// The picker stays inside the viewport so a thumb can reach every emoji.
				const pickerBox = await page.getByRole('button', { name: 'React with 👀' }).boundingBox()
				expect(pickerBox).not.toBeNull()
				expect((pickerBox?.x ?? -1) + (pickerBox?.width ?? 0)).toBeLessThanOrEqual(vp.width)
				expect(pickerBox?.x ?? -1).toBeGreaterThanOrEqual(0)
				await picture(page, testInfo, `picker-${vp.width}-${scheme}`)

				await page.getByRole('button', { name: 'React with 👍' }).click()
				const chip = page.getByRole('button', { name: /You reacted with 👍/ })
				await expect(chip).toBeVisible()
				await expect(chip).toHaveAttribute('aria-pressed', 'true')
				await expect(chip).toContainText('1')
				await picture(page, testInfo, `chip-${vp.width}-${scheme}`)

				// The server holds it: the list a second device reads carries the reaction.
				await expect
					.poll(async () => {
						const list = await account.api.listConversationMessages(conv.id, ws)
						return list.messages.find((m) => m.id === posted.id)?.reactions ?? []
					})
					.toMatchObject([{ emoji: '👍', count: 1, reactedByMe: true }])

				// And it survives a reload.
				await page.reload()
				await expect(page.getByRole('button', { name: /You reacted with 👍/ })).toBeVisible()

				// Pressing the chip takes the reaction back.
				await page.getByRole('button', { name: /You reacted with 👍/ }).click()
				await expect(page.getByRole('button', { name: /reacted with 👍/ })).toHaveCount(0)
				await expect
					.poll(async () => {
						const list = await account.api.listConversationMessages(conv.id, ws)
						return list.messages.find((m) => m.id === posted.id)?.reactions ?? []
					})
					.toEqual([])
				await page.reload()
				await expect(page.getByRole('button', { name: /reacted with 👍/ })).toHaveCount(0)
			})
		}
	}
	test('fast taps on the picker end with the server holding the last choice', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const ws = account.workspaceId
		const agent = await account.api.createAgentActor(`Reactor ${Date.now()}`)
		const conv = await account.api.createConversation(ws, {
			title: 'Fast reactions',
			participant_actor_ids: [agent.id],
		})
		const posted = await account.api.postConversationMessage(conv.id, ws, {
			content: 'Shipping the fix today.',
		})
		await page.goto(`/${ws}/chats/${conv.id}`)

		// 👍 three times in a row through the picker, with no pause: add, take back, add. Taking
		// back the only reaction removes the chip, so the picker is the control that is always there.
		// The calls reach the server in the order tapped, so what it ends up holding is what the
		// last tap chose, and what the chip shows.
		for (let tap = 0; tap < 3; tap++) {
			await page.getByRole('button', { name: 'Add reaction' }).first().click()
			await page.getByRole('button', { name: /^(React with|Take back) 👍$/ }).click()
		}

		await expect(page.getByRole('button', { name: /You reacted with 👍/ })).toBeVisible()
		await expect
			.poll(async () => {
				const list = await account.api.listConversationMessages(conv.id, ws)
				return list.messages.find((m) => m.id === posted.id)?.reactions ?? []
			})
			.toMatchObject([{ emoji: '👍', count: 1, reactedByMe: true }])
	})
})
