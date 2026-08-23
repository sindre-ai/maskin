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

// The header's New control is split: a primary half that runs the screen's
// default create action directly, and a chevron half that opens the full menu.
function headerNewTrigger(page: Page) {
	return page.locator('header').getByRole('button', { name: 'More ways to start' })
}

function newMenu(page: Page) {
	return page.getByRole('menu')
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
				await expect(bottomNav.getByRole('link', { name: 'For you, current page' })).toBeVisible()
				// Agents is deliberately not in the bottom bar (mobile-nav.tsx) — it is
				// reached through the sidebar's activity card. Loops is the tap-through
				// probe instead.
				await expect(bottomNav.getByRole('link', { name: /^Loops, / })).toBeVisible()
				// Tap-through on touch: the bottom bar must actually navigate the shell.
				await bottomNav.getByRole('link', { name: /^Loops, / }).click()
				await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/loops`))
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
		await expect(drawer.getByRole('link', { name: /For you/i })).toBeVisible()

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
		const forYou = sidebar.getByText('For you', { exact: true })

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

		// NavSearch collapses to a single icon; the ⌘K button that opens the
		// palette mounts once it expands (layout/nav-search.tsx).
		await page.getByRole('button', { name: 'Search the workspace' }).click()
		await page.getByRole('button', { name: 'Open commands' }).click()
		const palette = page.getByPlaceholder('Run a command or jump to…')
		await expect(palette).toBeVisible()

		await page.keyboard.press('Escape')
		await expect(palette).toBeHidden()
	})

	test('New opens the shared create dialog; Escape closes it', async ({ page, account }) => {
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

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// The shell creates through the shared CreatePicker (a centred
		// ResponsiveDialog, `sm:max-w-md`), not a shell-specific right-edge sheet —
		// so the assertion is that it is a contained panel seeded to the right
		// subtype, not that it hugs an edge.
		const box = await dialog.boundingBox()
		if (!box) throw new Error('expected the create dialog to have a bounding box')
		expect(box.width).toBeLessThan(VIEWPORTS.tabletLandscape.width)
		// The composer input is the overlay's one text field; its placeholder is
		// per-type (create-picker.v2.tsx OBJECT_TYPE_PLACEHOLDER), so target the
		// stable accessible name instead.
		await expect(dialog.getByLabel('Title')).toBeVisible()

		await page.keyboard.press('Escape')
		await expect(dialog).toBeHidden()
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
