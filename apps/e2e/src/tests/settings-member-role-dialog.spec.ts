import { expect, test } from '../fixtures/auth.fixture'
import { createTestActor } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Settings — HumanDetailDialog role change', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`admin can change a human member's role from the dialog at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const teammate = await createTestActor({
				name: `Teammate ${Date.now()}`,
				email: `teammate-${Date.now()}@test.invalid`,
			})
			await account.api.addWorkspaceMember(account.workspaceId, teammate.id, 'member')

			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/members`)
			await page.waitForLoadState('load')

			const teammateRow = page.getByRole('row', { name: new RegExp(teammate.name) })
			await expect(teammateRow).toBeVisible({ timeout: 10000 })

			await teammateRow.getByRole('button', { name: teammate.name }).click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()

			const roleSelect = dialog.getByRole('combobox', {
				name: new RegExp(`Role for ${teammate.name}`),
			})
			await expect(roleSelect).toBeVisible()
			await expect(roleSelect).toHaveText(/member/)

			await roleSelect.click()
			await page.getByRole('option', { name: 'admin' }).click()

			await expect(roleSelect).toHaveText(/admin/, { timeout: 10000 })

			await page.reload()
			await page.waitForLoadState('load')

			const rowAfter = page.getByRole('row', { name: new RegExp(teammate.name) })
			await expect(
				rowAfter.getByRole('combobox', { name: new RegExp(`Role for ${teammate.name}`) }),
			).toHaveText(/admin/, { timeout: 10000 })
		})
	}
})
