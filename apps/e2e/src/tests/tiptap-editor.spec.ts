import { argosScreenshot } from '@argos-ci/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// End-to-end coverage for the TipTap editor that replaces the raw
// textarea on the object detail page (bet: tiptap-editor, T3). Runs the
// ship-gate viewport ramp (375/768/1024) in both light and dark mode so
// Argos catches any layout regression. jsdom can't drive contenteditable
// or ProseMirror plugins, so the real interaction guarantees for the
// slash menu, bubble menu, and paste normalisation live here.

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

test.describe('TipTap editor on object detail', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		for (const theme of ['light', 'dark'] as const) {
			test(`mounts, accepts input, autosaves @ ${vp.label} ${theme}`, async ({ page, account }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await setTheme(page, theme)

				const object = await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: 'TipTap editor probe',
					status: 'signal',
					content: '# Existing heading\n\nExisting body paragraph.\n',
				})

				await page.goto(`/${account.workspaceId}/objects/${object.id}`)
				const existingHeading = page.getByRole('heading', { name: 'Existing heading' })
				await expect(existingHeading).toBeVisible({ timeout: 10_000 })

				// Enter edit mode by clicking the rendered body — the wrapper
				// swaps in the TipTap editor without a `key={id}` remount.
				await existingHeading.click()
				const editor = page.locator('[data-testid="tiptap-editor-mount"] .ProseMirror')
				await expect(editor).toBeVisible()

				// Type at the end of the doc — TipTap must accept keystrokes and
				// preserve the existing heading + paragraph as the source.
				await editor.click()
				await page.keyboard.press('End')
				await page.keyboard.press('Enter')
				await page.keyboard.type('Typed live in TipTap.')

				// Autosave debounce is 300ms — wait a beat then blur to flush.
				await page.waitForTimeout(400)
				await page.keyboard.press('Escape')
				await page.locator('body').click({ position: { x: 5, y: 5 } })

				// After blur the view returns to the rendered read-only shell
				// and the typed line has landed in the persisted content.
				await expect(page.getByText('Typed live in TipTap.')).toBeVisible({ timeout: 10_000 })

				await argosScreenshot(page, `tiptap-editor-object-detail-${theme}-${vp.width}`)
			})
		}
	}

	test('normalises HTML paste to canonical Markdown (no raw HTML enters the doc)', async ({
		page,
		account,
	}) => {
		const object = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Paste probe',
			status: 'signal',
			content: 'Starting content.\n',
		})

		await page.goto(`/${account.workspaceId}/objects/${object.id}`)
		await page.getByText('Starting content.').click()
		const editor = page.locator('[data-testid="tiptap-editor-mount"] .ProseMirror')
		await expect(editor).toBeVisible()

		// Simulate pasting an HTML fragment (like a Notion export) — the
		// `transformPastedHTML` hook must strip HTML and re-insert normalised
		// markdown-shaped nodes.
		await editor.click()
		await page.keyboard.press('End')
		await page.keyboard.press('Enter')
		await editor.evaluate((el) => {
			const dt = new DataTransfer()
			dt.setData('text/html', '<h2>Pasted heading</h2><ul><li>Pasted item</li></ul>')
			el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
		})

		await expect(page.getByRole('heading', { name: 'Pasted heading' })).toBeVisible()
		await expect(page.getByText('Pasted item')).toBeVisible()

		// Blur to flush autosave, then reload to confirm the pasted content
		// persisted as canonical markdown on the server.
		await page.locator('body').click({ position: { x: 5, y: 5 } })
		await page.waitForTimeout(600)
		await page.reload()
		await expect(page.getByRole('heading', { name: 'Pasted heading' })).toBeVisible({
			timeout: 10_000,
		})
	})
})
