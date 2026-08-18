import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// App shell — Direction 1 "One Shell" from the signed-off UX decision: shared
// sidebar (216px ↔ 60px icon rail), per-view collapse persistence, header with
// ⌘K trigger, right-edge create sheet, and the mobile bottom bar + off-canvas
// drawer. This spec exercises the shell behaviours that unit tests cannot:
// the real viewport-driven mobile/desktop split, Radix Sheet overlay dismissal,
// collapse state that survives a full reload, the create sheet's edge geometry,
// and light/dark rendering of the chrome at the small viewport.

function headerNewTrigger(page: Page) {
	return page.locator('header').getByRole('button', { name: /^new$/i })
}

function newMenu(page: Page) {
	return page.getByRole('menu', { name: 'New' })
}

// Two `[data-sidebar="sidebar"]` roots render inside the workspace: the left
// AppSidebar (this file's target) and the right ChatPanel. Scope through the
// left sidebar wrapper's `data-side="left"` so the width probe measures the
// nav sidebar, not the chat panel.
function leftSidebar(page: Page) {
	return page.locator('[data-side="left"] [data-sidebar="sidebar"]')
}

function sidebarWidth(page: Page) {
	return async () => Math.round((await leftSidebar(page).boundingBox())?.width ?? 0)
}

test.describe('App shell', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`bottom bar is the primary nav at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}`)
			const bottomNav = page.getByRole('navigation', { name: 'Primary' })
			if (vp.width < 768) {
				await expect(bottomNav).toBeVisible()
				await expect(bottomNav.getByRole('link', { name: 'For You, current page' })).toBeVisible()
				await expect(bottomNav.getByRole('link', { name: /^Agents, / })).toBeVisible()
				// Tap-through on touch: the bottom bar must actually navigate the shell.
				await bottomNav.getByRole('link', { name: /^Agents, / }).click()
				await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents`))
			} else {
				await expect(bottomNav).toBeHidden()
			}
		})
	}

	test('mobile sidebar opens as a sheet and a scrim tap dismisses it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		await page.emulateMedia({ reducedMotion: 'reduce' })
		await page.goto(`/${account.workspaceId}`)
		// The mobile AppSidebar renders as a Radix Sheet with SheetTitle "Sidebar" —
		// scoping by role+name isolates it from the right-side ChatPanel, which also
		// uses the shadcn Sidebar primitive.
		const drawer = page.getByRole('dialog', { name: 'Sidebar' })
		await expect(drawer).toBeHidden()

		await page.getByRole('button', { name: /toggle sidebar/i }).click()
		await expect(drawer).toBeVisible()
		await expect(drawer.getByRole('link', { name: /For You/ })).toBeVisible()

		// Tap the scrim to the right of the 288px drawer on the 375px viewport — Radix
		// pointer-down-outside closes the Sheet.
		await page.mouse.click(VIEWPORTS.mobile.width - 20, 300)
		await expect(drawer).toBeHidden()
	})

	test('mobile drawer links close the drawer and navigate', async ({ page, account }) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		await page.goto(`/${account.workspaceId}`)
		const drawer = page.getByRole('dialog', { name: 'Sidebar' })

		await page.getByRole('button', { name: /toggle sidebar/i }).click()
		await expect(drawer.getByRole('link', { name: /Loops/ })).toBeVisible()
		await drawer.getByRole('link', { name: /Loops/ }).click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/loops`))
		await expect(drawer).toBeHidden()
	})

	test('desktop sidebar collapses to a 60px icon rail and expands back', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}`)
		const sidebar = leftSidebar(page)
		const forYou = sidebar.getByText('For You', { exact: true })

		await expect.poll(sidebarWidth(page)).toBe(216)
		await expect(forYou).toBeVisible()

		const rail = page.getByRole('button', { name: 'Toggle Sidebar' })
		await rail.click()
		await expect.poll(sidebarWidth(page)).toBe(60)
		// Icon-collapse hides the text labels — only icons remain.
		await expect(forYou).toBeHidden()

		await rail.click()
		await expect.poll(sidebarWidth(page)).toBe(216)
		await expect(forYou).toBeVisible()
	})

	test('per-view collapse state persists across navigation and reload', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}`)
		const rail = page.getByRole('button', { name: 'Toggle Sidebar' })

		// Collapse on Home (view key `home`).
		await rail.click()
		await expect.poll(sidebarWidth(page)).toBe(60)

		// Settings is its own view key — navigation re-expands the sidebar.
		await page.goto(`/${account.workspaceId}/settings`)
		await expect.poll(sidebarWidth(page)).toBe(216)

		// Collapse again on Settings; a full reload keeps it collapsed.
		await rail.click()
		await expect.poll(sidebarWidth(page)).toBe(60)
		await page.reload()
		await expect.poll(sidebarWidth(page)).toBe(60)

		// Back on Home the earlier collapsed state is still honored.
		await page.goto(`/${account.workspaceId}`)
		await expect.poll(sidebarWidth(page)).toBe(60)
	})

	test('header ⌘K trigger opens the command palette and Escape closes it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('button', { name: /search and run commands/i }).click()
		await expect(page.getByPlaceholder('Search objects, navigate...')).toBeVisible()

		await page.keyboard.press('Escape')
		await expect(page.getByPlaceholder('Search objects, navigate...')).toBeHidden()
	})

	test('New opens a right-edge create sheet; Cancel and Escape close it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		// "Create an object" is the group label; the first object menuitem underneath
		// it opens the CreatePicker seeded to that subtype.
		await newMenu(page)
			.getByRole('menuitem', { name: /^new task$/i })
			.click()

		const sheet = page.getByRole('dialog')
		await expect(sheet).toBeVisible()
		const box = await sheet.boundingBox()
		if (!box) throw new Error('expected the create sheet to have a bounding box')
		// Right-edge sheet: the panel hugs the viewport's right edge and is narrower
		// than the full viewport (a centered dialog would sit mid-screen).
		expect(Math.abs(box.x + box.width - VIEWPORTS.tabletLandscape.width)).toBeLessThanOrEqual(1)
		expect(box.width).toBeLessThan(VIEWPORTS.tabletLandscape.width)

		await sheet.getByRole('button', { name: 'Cancel' }).click()
		await expect(sheet).toBeHidden()

		await headerNewTrigger(page).click()
		await newMenu(page)
			.getByRole('menuitem', { name: /^new task$/i })
			.click()
		await expect(page.getByRole('dialog')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.getByRole('dialog')).toBeHidden()
	})

	test('shell surfaces render in light and dark mode at 375px', async ({ page, account }) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		const html = page.locator('html')
		for (const scheme of ['light', 'dark'] as const) {
			await page.goto(`/${account.workspaceId}`)
			await page.evaluate((s) => localStorage.setItem('maskin-theme', s), scheme)
			await page.reload()

			if (scheme === 'dark') {
				await expect(html).toHaveClass(/dark/)
			} else {
				await expect(html).not.toHaveClass(/dark/)
			}
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
			await expect(page.getByRole('button', { name: /toggle sidebar/i })).toBeVisible()
		}
	})
})
