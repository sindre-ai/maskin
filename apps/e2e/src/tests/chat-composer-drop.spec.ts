import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Dropping a file on the chat composer attaches it, the same as the + menu's Attach file: an
 * upload chip appears, and the composer shows a dashed outline while the file is over it.
 */

for (const viewport of SHIP_GATE_VIEWPORTS) {
	for (const scheme of ['light', 'dark'] as const) {
		test.describe(`Composer drop — ${viewport.label} — ${scheme}`, () => {
			test.use({ viewport: { width: viewport.width, height: viewport.height } })

			test.beforeEach(async ({ page }) => {
				await page.addInitScript((mode: string) => {
					localStorage.setItem('maskin-theme', mode)
				}, scheme)
			})

			test('a dropped file shows the drop outline, then attaches', async ({ page, account }) => {
				const conversation = await account.api.createConversation(account.workspaceId, {
					title: `Drop ${Date.now()}`,
					participant_actor_ids: [],
					initial_message: 'A conversation to drop into',
				})
				await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
				const textbox = page.getByRole('textbox').last()
				await expect(textbox).toBeVisible({ timeout: 10_000 })
				const bar = textbox.locator('xpath=ancestor::form[1]/div[1]')

				const dataTransfer = await page.evaluateHandle(() => {
					const dt = new DataTransfer()
					dt.items.add(new File(['hello'], 'dropped-note.txt', { type: 'text/plain' }))
					return dt
				})

				await bar.dispatchEvent('dragover', { dataTransfer })
				await expect(bar).toHaveClass(/outline-dashed/)

				await bar.dispatchEvent('drop', { dataTransfer })
				await expect(bar).not.toHaveClass(/outline-dashed/)
				await expect(page.getByText('dropped-note.txt').first()).toBeVisible({ timeout: 10_000 })
			})
		})
	}
}
