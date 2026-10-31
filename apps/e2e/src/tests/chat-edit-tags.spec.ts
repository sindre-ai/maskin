import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The picture goes into the HTML report as an attachment (apps/e2e/playwright-report, uploaded by
// CI as the playwright-report-N artifact), because test-results/ is not uploaded.
async function picture(page: Page, testInfo: TestInfo, name: string) {
	// Border and ring ease over 180ms; let them settle before the picture.
	await page.waitForTimeout(400)
	await testInfo.attach(name, {
		body: await page.screenshot({ path: `test-results/${name}.png` }),
		contentType: 'image/png',
	})
}

test.describe('Chat — editing a message with tags inside the text', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`an old message opens with its tag as a chip, a new tag goes in as a chip, Backspace removes it at ${vp.width}px in ${scheme}`, async ({
				page,
				account,
			}, testInfo) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				// The app defaults to light; the theme setting is what switches it.
				await page.addInitScript((mode) => localStorage.setItem('maskin-theme', mode), scheme)
				const ws = account.workspaceId
				const stamp = Date.now()
				const cto = await account.api.createAgentActor(`Tagcto ${stamp}`)
				const dev = await account.api.createAgentActor(`Tagdev ${stamp}`)
				const conv = await account.api.createConversation(ws, {
					title: 'Tag edit',
					participant_actor_ids: [cto.id, dev.id],
				})
				// Sent before tags lived in the text: the id is in the list, the name is not in the text.
				await account.api.postConversationMessage(conv.id, ws, {
					content: 'please start on the MCP tool',
					metadata: { mentions: [cto.id] },
				})

				await page.goto(`/${ws}/chats/${conv.id}`)
				await page.getByRole('button', { name: 'Edit message' }).first().click()
				const box = page.getByRole('textbox', { name: 'Edit message' })

				// The tag from outside the text is now a chip at the start.
				await expect(box.locator('[data-tag-id]')).toHaveCount(1)
				await expect(box).toContainText(`@Tagcto ${stamp} please start on the MCP tool`)
				await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
				// The key hint needs room: shown from 1024px, hidden on the phone and in the narrow iPad column.
				const hint = page.getByText('@ tags · Enter saves')
				if (vp.width >= 1024) await expect(hint).toBeVisible()
				else await expect(hint).toBeHidden()
				await picture(page, testInfo, `edit-card-${vp.width}-${scheme}`)

				// Type @, pick the other agent: a chip lands inside the sentence.
				await box.press('End')
				await page.keyboard.type(' and @')
				const option = page.getByRole('option', { name: new RegExp(`Tagdev ${stamp}`) })
				await expect(option).toBeVisible()
				await picture(page, testInfo, `picker-${vp.width}-${scheme}`)
				if (vp.width < 768) await option.click()
				else await page.keyboard.press('ArrowDown') // the first row is Tagcto; move to Tagdev
				if (vp.width >= 768) await page.keyboard.press('Enter')
				await expect(box.locator('[data-tag-id]')).toHaveCount(2)
				await expect(page.getByText(`Tagdev ${stamp} will get this when you save.`)).toBeVisible()
				await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
				await picture(page, testInfo, `two-chips-${vp.width}-${scheme}`)

				// Backspace right after the chip's space removes the space, the next one the whole chip.
				await box.focus()
				await page.keyboard.press('Backspace')
				await page.keyboard.press('Backspace')
				await expect(box.locator('[data-tag-id]')).toHaveCount(1)
				await expect(page.getByText(/will get this when you save/)).toHaveCount(0)

				// Cancel brings the untouched bubble back.
				await page.getByRole('button', { name: 'Cancel' }).click()
				await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
				await expect(page.getByText('please start on the MCP tool').first()).toBeVisible()
			})
		}
	}
})
