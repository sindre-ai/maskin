import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const SWITCH_NAME = 'Make this my default workspace'

function defaultSwitch(page: Page) {
	return page.getByRole('switch', { name: SWITCH_NAME })
}

async function openGeneralSettings(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings`)
	// Wait for the switch to mount (auth guard + workspace query) before asserting state.
	await expect(defaultSwitch(page)).toBeVisible({ timeout: 30_000 })
}

test.describe('Default workspace — settings switch', () => {
	test.describe.configure({ timeout: 60_000 })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test.describe(viewport.label, () => {
			test.use({ viewport: { width: viewport.width, height: viewport.height } })

			test('setting the default persists across reload and can be cleared', async ({
				page,
				account,
			}) => {
				await openGeneralSettings(page, account.workspaceId)
				const toggle = defaultSwitch(page)
				await expect(toggle).not.toBeChecked()

				await toggle.click()
				await expect(toggle).toBeChecked()

				await page.reload()
				await expect(defaultSwitch(page)).toBeVisible({ timeout: 30_000 })
				await expect(defaultSwitch(page)).toBeChecked()

				await defaultSwitch(page).click()
				await expect(defaultSwitch(page)).not.toBeChecked()

				await page.reload()
				await expect(defaultSwitch(page)).toBeVisible({ timeout: 30_000 })
				await expect(defaultSwitch(page)).not.toBeChecked()
			})

			test('choosing another workspace moves the default', async ({ page, account }) => {
				// A trial actor may own a single workspace - this spec needs two.
				await grantPlanHeadroom(account.apiKey, account.workspaceId)
				const other = await account.api.createWorkspace(`Second ${Date.now()}`)

				await openGeneralSettings(page, account.workspaceId)
				await defaultSwitch(page).click()
				await expect(defaultSwitch(page)).toBeChecked()

				await openGeneralSettings(page, other.id)
				await expect(defaultSwitch(page)).not.toBeChecked()
				await defaultSwitch(page).click()
				await expect(defaultSwitch(page)).toBeChecked()

				// One default at a time: the first workspace's switch is now off.
				await openGeneralSettings(page, account.workspaceId)
				await expect(defaultSwitch(page)).not.toBeChecked()
			})
		})
	}

	test('the switch is visible in light and dark mode', async ({ page, account }) => {
		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await openGeneralSettings(page, account.workspaceId)
			await expect(defaultSwitch(page)).toBeVisible()
		}
	})
})
