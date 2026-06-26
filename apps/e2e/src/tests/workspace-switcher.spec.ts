import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

async function openSidebarOnMobile(page: Page) {
	const trigger = page.getByRole('button', { name: /toggle sidebar/i }).first()
	if (await trigger.isVisible().catch(() => false)) {
		await trigger.click()
	}
}

test.describe('Workspace switcher (SidebarHeader pill)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows current workspace name without hover at ${viewport.label} (AC-U1)`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

			await openSidebarOnMobile(page)

			const pill = page.getByRole('button', { name: /switch workspace/i })
			await expect(pill).toBeVisible()
			await expect(pill).toContainText('My Workspace')
		})
	}

	test('opens the switcher and marks the current workspace (AC-U2)', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		await page.getByRole('button', { name: /switch workspace/i }).click()

		const menu = page.getByRole('menu')
		await expect(menu).toBeVisible()
		const currentRow = menu.getByRole('menuitem', { name: 'My Workspace' })
		await expect(currentRow).toBeVisible()
		await expect(currentRow.locator('svg')).toBeVisible()
	})

	test('selecting another workspace navigates and the pill updates (AC-U3, AC-T4)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const second = await account.api.createWorkspace(`E2E Switch Target ${Date.now()}`)

		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		await page.getByRole('button', { name: /switch workspace/i }).click()
		await page.getByRole('menuitem', { name: second.name }).click()

		await expect(page).toHaveURL(new RegExp(second.id), { timeout: 10_000 })
		const pill = page.getByRole('button', { name: /switch workspace/i })
		await expect(pill).toContainText(second.name)
		// No stale leak: the previous workspace name is gone from the pill.
		await expect(pill).not.toContainText('My Workspace')
	})

	test('sidebar shell does not shift while workspaces load (AC-T2)', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		// Slow the workspaces list so the loading branch is visible.
		await page.route('**/api/workspaces', async (route) => {
			await new Promise((r) => setTimeout(r, 400))
			return route.continue()
		})

		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		const sidebar = page.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first()
		const firstWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
		await page.waitForLoadState('networkidle')
		const finalWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
		expect(Math.abs(finalWidth - firstWidth)).toBeLessThanOrEqual(1)
	})
})
