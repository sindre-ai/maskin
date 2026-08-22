import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// On mobile the sidebar is an off-canvas Sheet (a modal Radix dialog), and both
// sidebar dropdowns — the workspace switcher and the account menu — open nested
// inside it. Two stacked modal layers share one registry for
// `body { pointer-events }`, so if that registry is ever duplicated the outer
// restore never runs and the whole app goes dead to taps: every later click,
// including the dropdowns themselves, does nothing. That is exactly what a
// duplicated Radix dismissable-layer module produced under the dev server
// (fixed by excluding cmdk from Vite's dep pre-bundling in
// apps/web/vite.config.ts).
//
// These tests therefore assert both halves: the menus open with real content,
// and the page stays interactive afterwards.
test.describe('Mobile sidebar dropdowns', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	async function openDrawer(page: import('@playwright/test').Page) {
		await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click()
		await expect(page.getByRole('dialog')).toBeVisible()
	}

	test('the workspace switcher opens inside the drawer and leaves the app interactive', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}`)
		await openDrawer(page)

		await page.getByRole('button', { name: /^Switch workspace/ }).click()
		await expect(page.getByRole('menu')).toBeVisible()
		await expect(page.getByRole('menuitem', { name: /Workspace settings/ })).toBeVisible()

		// Selecting the current workspace closes both layers at once — the case
		// that used to strand `pointer-events: none` on <body>.
		await page.getByRole('menuitem').first().click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none')

		// The real proof: the drawer still responds to a tap.
		await openDrawer(page)
	})

	test('the account menu opens inside the drawer and leaves the app interactive', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}`)
		await openDrawer(page)

		const triggers = page.locator('[role="dialog"] [aria-haspopup="menu"]')
		await triggers.last().click()
		await expect(page.getByRole('menu')).toBeVisible()
		await expect(page.getByRole('menuitem', { name: /Sign out/ })).toBeVisible()

		await page.getByRole('menuitem', { name: /Settings/ }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/settings`))
		expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none')

		await openDrawer(page)
	})
})
