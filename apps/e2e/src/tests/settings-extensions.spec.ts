import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Extensions settings surface (T2).
 *
 * A fresh E2E account's workspace defaults `enabled_modules` to `['work']`, so
 * the Extensions page lists the Work, Knowledge and CRM modules with only Work
 * enabled. These specs assert the section renders at every ship-gate viewport,
 * that the enabled/disabled state is reflected in each row's toggle, and that a
 * toggle persists across a page reload.
 */

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function openExtensionsPage(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/extensions`)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

/** The module row (the padded flex card containing the module's name + toggle). */
function moduleRow(page: Page, name: string) {
	return page
		.locator('div.flex.items-center.justify-between.rounded-lg')
		.filter({ has: page.getByText(name, { exact: true }) })
}

test.describe('Settings — Extensions page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the extensions list with toggles at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openExtensionsPage(page, account.workspaceId)

			// Settings nav (vertical rail on md+, horizontal chip strip on mobile) exposes Extensions.
			await expect(page.getByRole('link', { name: 'Extensions' }).first()).toBeVisible({
				timeout: 10000,
			})

			// The section and its helper text render.
			await expect(
				page.getByText('Enable or disable extensions for this workspace').first(),
			).toBeVisible()

			// The registered modules are listed with their names.
			await expect(page.getByText('Work', { exact: true }).first()).toBeVisible()
			await expect(page.getByText('CRM', { exact: true }).first()).toBeVisible()
			await expect(page.getByText('Knowledge', { exact: true }).first()).toBeVisible()

			// Default state: Work enabled, CRM and Knowledge disabled.
			await expect(moduleRow(page, 'Work').getByRole('switch')).toBeChecked()
			await expect(moduleRow(page, 'CRM').getByRole('switch')).not.toBeChecked()
			await expect(moduleRow(page, 'Knowledge').getByRole('switch')).not.toBeChecked()
		})
	}

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`persists toggling an extension across reload at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openExtensionsPage(page, account.workspaceId)

			const crmSwitch = moduleRow(page, 'CRM').getByRole('switch')
			await expect(crmSwitch).not.toBeChecked({ timeout: 10000 })
			await crmSwitch.click()

			// Toggle state reflects the persisted workspace settings after refetch…
			await expect(crmSwitch).toBeChecked()
			// …and survives a full page reload.
			await page.reload()
			await expect(
				page.getByText('Enable or disable extensions for this workspace').first(),
			).toBeVisible({ timeout: 10000 })
			await expect(moduleRow(page, 'CRM').getByRole('switch')).toBeChecked()
		})
	}

	test('renders the extensions surface in both light and dark mode', async ({ page, account }) => {
		for (const theme of ['light', 'dark'] as const) {
			await setTheme(page, theme)
			await page.setViewportSize(VIEWPORTS.mobile)
			await page.goto(`/${account.workspaceId}/settings/extensions`)
			await page.waitForLoadState('load')
			await page.waitForTimeout(300)

			if (theme === 'dark') {
				const isDark = await page.evaluate(() =>
					document.documentElement.classList.contains('dark'),
				)
				expect(isDark).toBe(true)
			}

			await expect(
				page.getByText('Enable or disable extensions for this workspace').first(),
			).toBeVisible()
			await expect(moduleRow(page, 'Work').getByRole('switch')).toBeChecked()
			await expect(moduleRow(page, 'CRM').getByRole('switch')).toBeVisible()
		}
	})
})
