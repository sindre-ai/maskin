import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The Items page's Files tab lists every file in the workspace and each row
// opens that file's viewer.

test.describe('Items Files tab', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`lists workspace files and opens one — ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const file = await account.api.createFile(account.workspaceId, {
				name: 'items-files-tab-notes.md',
				mime_type: 'text/markdown',
				content: '# Notes',
				encoding: 'utf8',
			})

			await page.goto(`/${account.workspaceId}/objects?type=file`)
			const row = page.getByRole('link', { name: /items-files-tab-notes\.md/ })
			await expect(row).toBeVisible({ timeout: 10000 })
			await expect(row).toHaveAttribute('href', `/${account.workspaceId}/files/${file.id}`)

			// No horizontal page scroll at any ship-gate width.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)

			await row.click()
			await expect(page).toHaveURL(new RegExp(`/files/${file.id}`))
		})
	}

	test('Files tab is reachable from the type tab strip', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)
		await page.getByRole('button', { name: 'Files' }).click()
		await expect(page).toHaveURL(/type=file/)
	})
})
