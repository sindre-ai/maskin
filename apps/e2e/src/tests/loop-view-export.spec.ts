import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Export in the three-dot menu of a custom view (flag loop-view-export). The file is built in the
 * browser from what the view's frame drew, so a download whose text matches the view proves the
 * whole path: menu -> request to the frame -> its answer -> Markdown -> saved file.
 */
const VIEW_HTML = `<!doctype html><html><body>
<h1>Open deals</h1>
<table><thead><tr><th>Deal</th><th>Value</th></tr></thead><tbody><tr><td>Acme</td><td>12</td></tr></tbody></table>
<ul><li>First item</li></ul>
</body></html>`

async function setFlag(page: Page, value: 'on' | 'off') {
	await page.addInitScript((v) => localStorage.setItem('ff:loop-view-export', v), value)
}

async function seedViewLoop(account: {
	workspaceId: string
	api: import('../helpers/api.helper').TestAPI
}) {
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title: 'Export loop',
		status: 'learning',
	})
	const file = await account.api.createFile(account.workspaceId, {
		name: 'open-deals.html',
		mime_type: 'text/html',
		content: VIEW_HTML,
	})
	await account.api.updateObject(loop.id, account.workspaceId, {
		metadata: { views: [{ name: 'Open deals', file_id: file.id }] },
	})
	return loop
}

async function openView(page: Page, workspaceId: string, loopId: string) {
	await page.goto(`/${workspaceId}/loops/${loopId}`)
	await expect(page.getByRole('tablist', { name: 'Flow sections' })).toBeVisible({
		timeout: 15_000,
	})
	const tab = page.getByRole('tab', { name: 'Open deals', exact: true })
	if ((await tab.count()) > 0) await tab.click()
	else {
		await page.getByRole('button', { name: /^More \(\d+\)$/ }).click()
		await page.getByRole('menuitemradio', { name: 'Open deals', exact: true }).click()
	}
	await expect(page.locator('iframe[title="Custom flow view"]')).toBeVisible({ timeout: 15_000 })
}

test.describe('Loop page — export a view', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`Export offers three formats and saves Markdown of the view @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await setFlag(page, 'on')
			const loop = await seedViewLoop(account)
			await openView(page, account.workspaceId, loop.id)
			// Let the frame draw before it is asked for its pages.
			await expect(
				page
					.frameLocator('iframe[title="Custom flow view"]')
					.frameLocator('iframe')
					.getByText('First item'),
			).toBeVisible({ timeout: 15_000 })

			await page.getByRole('button', { name: 'View actions' }).click()
			await page.getByText('Export', { exact: true }).click()
			for (const label of ['Markdown', 'PDF', 'PNG']) {
				await expect(page.getByRole('menuitem', { name: label })).toBeVisible()
			}

			// Keyboard, because the sub-menu closes under a pointer that crosses its gap.
			await page.getByRole('menuitem', { name: 'Markdown' }).focus()
			const [download] = await Promise.all([
				page.waitForEvent('download', { timeout: 25_000 }),
				page.keyboard.press('Enter'),
			])
			expect(download.suggestedFilename()).toMatch(/^open-deals-\d{4}-\d{2}-\d{2}\.md$/)
			const path = await download.path()
			const text = await readFile(path, 'utf8')
			expect(text).toContain('# Open deals')
			expect(text).toContain('| Deal | Value |')
			expect(text).toContain('| Acme | 12 |')
			expect(text).toContain('- First item')
			await expect(page.getByRole('alert')).toHaveCount(0)
		})
	}

	test('has no Export with the flag off', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await setFlag(page, 'off')
		const loop = await seedViewLoop(account)
		await openView(page, account.workspaceId, loop.id)
		// The view can be renamed and removed, so the menu is there, without Export.
		await page.getByRole('button', { name: 'View actions' }).click()
		await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
		await expect(page.getByText('Export', { exact: true })).toHaveCount(0)
	})
})
