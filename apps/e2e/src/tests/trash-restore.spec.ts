import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Settings → Trash lists a row an agent deleted and restores it. The screen is behind
// the trash-restore flag; the test-only localStorage override turns it on for this run,
// so no second actor is needed.
test.describe('Trash restore', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`restores a deleted item from Settings → Trash at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const title = `Trash me ${vp.width}`
			const item = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title,
				status: 'todo',
			})
			await account.api.deleteObject(item.id, account.workspaceId)

			// Test-only override, read synchronously by useFeatureFlag.
			await page.addInitScript(() => localStorage.setItem('ff:trash-restore', 'on'))

			await page.goto(`/${account.workspaceId}/settings/trash`)
			await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible({ timeout: 10000 })
			const row = page.getByRole('listitem').filter({ hasText: title })
			await expect(row).toBeVisible()

			await row.getByRole('button', { name: 'Restore' }).click()
			await expect(page.getByText(title)).toHaveCount(0, { timeout: 10000 })

			const objects = await account.api.listObjects(account.workspaceId)
			expect(objects.some((o) => o.id === item.id)).toBe(true)

			// No horizontal page scroll at any ship-gate width.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)
		})
	}
})
