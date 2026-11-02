import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openSidebarOnMobile } from '../helpers/sidebar.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The product words are Items and Flows (formerly Objects and Loops). The nav, page titles
 * and New commands use the new words; the command palette still finds them by the old
 * words, because search keeps both. URLs stay /objects and /loops.
 */

async function openPalette(page: Page) {
	await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible({
		timeout: 20_000,
	})
	await page.keyboard.press('ControlOrMeta+k')
	const panel = page.getByRole('dialog', { name: 'Command palette' })
	await expect(panel).toBeVisible({ timeout: 15_000 })
	return panel
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Items and Flows wording at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('navigation reads Flows and Items, never Loops or Objects', async ({ page, account }) => {
			await page.goto(`/${account.workspaceId}`)
			await openSidebarOnMobile(page)

			const nav =
				vp.width < 768
					? page.getByRole('dialog', { name: 'Sidebar' })
					: page.locator('[data-sidebar="sidebar"]').first()
			await expect(nav.getByRole('link', { name: /Flows/ }).first()).toBeVisible({
				timeout: 15_000,
			})
			await expect(nav.getByRole('link', { name: /Items/ }).first()).toBeVisible()
			await expect(nav.getByRole('link', { name: /Loops/ })).toHaveCount(0)
			await expect(nav.getByRole('link', { name: /Objects/ })).toHaveCount(0)
		})

		test('the Items and Flows pages carry the new titles', async ({ page, account }) => {
			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByRole('heading', { level: 1, name: 'Items', exact: true })).toBeVisible(
				{ timeout: 15_000 },
			)
			await expect(page.getByRole('heading', { level: 1, name: 'Objects' })).toHaveCount(0)

			await page.goto(`/${account.workspaceId}/loops`)
			await expect(page.getByRole('heading', { level: 1, name: 'Flows', exact: true })).toBeVisible(
				{ timeout: 15_000 },
			)
			await expect(page.getByRole('heading', { level: 1, name: 'Loops' })).toHaveCount(0)
		})

		test('the New menu offers New item and New flow', async ({ page, account }) => {
			await page.goto(`/${account.workspaceId}`)
			await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()

			const menu = page.getByRole('menu')
			await expect(menu.getByText('Create an item')).toBeVisible()
			await expect(menu.getByRole('menuitem', { name: /new flow/i })).toBeVisible()
			await expect(menu.getByRole('menuitem', { name: /new loop/i })).toHaveCount(0)
			await expect(menu.getByText('Create an object')).toHaveCount(0)
		})

		test('the command palette offers New flow and still finds Flows and Items by the old words', async ({
			page,
			account,
		}) => {
			await page.goto(`/${account.workspaceId}/objects`)
			const panel = await openPalette(page)
			const field = panel.getByRole('combobox', { name: 'Search or run a command' })

			await field.fill('new flow')
			await expect(panel.getByRole('option', { name: /New flow/ }).first()).toBeVisible()

			// "loops" and "objects" are kept as search words: the renamed rows still match.
			await field.fill('loops')
			await expect(panel.getByRole('option', { name: /Flows|New flow/ }).first()).toBeVisible({
				timeout: 15_000,
			})

			await field.fill('objects')
			await expect(panel.getByRole('option', { name: /Items/ }).first()).toBeVisible({
				timeout: 15_000,
			})
		})
	})
}
