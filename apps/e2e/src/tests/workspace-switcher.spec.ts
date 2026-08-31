import { expect, test } from '../fixtures/auth.fixture'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { openSidebarOnMobile } from '../helpers/sidebar.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

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
			await expect(pill).toContainText(account.workspaceName)
		})
	}

	test('opens the switcher and marks the current workspace (AC-U2)', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		await page.getByRole('button', { name: /switch workspace/i }).click()

		const menu = page.getByRole('menu')
		await expect(menu).toBeVisible()
		const currentRow = menu.getByRole('menuitem', { name: account.workspaceName })
		await expect(currentRow).toBeVisible()
		await expect(currentRow.locator('svg')).toBeVisible()
	})

	test('selecting another workspace navigates and the pill updates (AC-U3, AC-T4)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		// A trial actor may own a single workspace — this spec needs two.
		await grantPlanHeadroom(account.apiKey, account.workspaceId)
		const second = await account.api.createWorkspace(`E2E Switch Target ${Date.now()}`)

		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		await page.getByRole('button', { name: /switch workspace/i }).click()
		await page.getByRole('menuitem', { name: second.name }).click()

		await expect(page).toHaveURL(new RegExp(second.id), { timeout: 10_000 })
		const pill = page.getByRole('button', { name: /switch workspace/i })
		await expect(pill).toContainText(second.name)
		// No stale leak: the previous workspace name is gone from the pill.
		await expect(pill).not.toContainText(account.workspaceName)
	})

	test('labels each workspace row with its member count, not the caller role', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		await page.getByRole('button', { name: /switch workspace/i }).click()

		const currentRow = page.getByRole('menu').getByRole('menuitem', { name: account.workspaceName })
		// A freshly seeded workspace has exactly one human member — the caller —
		// so it reads "just you" rather than "1 members" or the role word.
		await expect(currentRow).toContainText('just you')
		await expect(currentRow).not.toContainText('owner')
	})

	test('creates a workspace from the switcher and lands in it', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		const name = `E2E Created ${Date.now()}`
		await page.getByRole('button', { name: /switch workspace/i }).click()
		await page.getByRole('menuitem', { name: /new workspace/i }).click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await dialog.getByLabel('Name').fill(name)
		await dialog.getByRole('button', { name: /create workspace/i }).click()

		// Creating seeds the default agent crew server-side, so give it room.
		await expect(page).not.toHaveURL(new RegExp(account.workspaceId), { timeout: 30_000 })
		await expect(page.getByRole('button', { name: /switch workspace/i })).toContainText(name, {
			timeout: 30_000,
		})
	})

	test('the workspace tile expands the sidebar when collapsed to the rail', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		const pill = page.getByRole('button', { name: /switch workspace/i })
		await expect(pill).toBeVisible()

		await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
		// Collapsed, the tile is the expand affordance — not the workspace menu.
		const tile = page.getByRole('button', { name: 'Expand sidebar' })
		await expect(tile).toBeVisible()
		await tile.click()

		await expect(page.getByRole('menu')).toHaveCount(0)
		await expect(page.getByRole('button', { name: /switch workspace/i })).toBeVisible()
	})

	test('sidebar shell does not shift while workspaces load (AC-T2)', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		// Slow the workspaces list so the loading branch is visible.
		const workspacesLoaded = page.waitForResponse('**/api/workspaces')
		await page.route('**/api/workspaces', async (route) => {
			await new Promise((r) => setTimeout(r, 400))
			return route.continue()
		})

		await page.goto(`/${account.workspaceId}`)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10_000 })

		const sidebar = page.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first()
		const firstWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
		// `networkidle` never fires — the app holds an SSE connection to /api/events —
		// so wait for the slowed workspaces response itself, then let React settle.
		await workspacesLoaded
		await page.waitForTimeout(100)
		const finalWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
		expect(Math.abs(finalWidth - firstWidth)).toBeLessThanOrEqual(1)
	})
})
