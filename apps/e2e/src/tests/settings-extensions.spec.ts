import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * Extensions settings surface (T2).
 *
 * A fresh E2E account's workspace defaults `enabled_modules` to
 * `['work', 'knowledge', 'crm']`, so the Extensions page lists all three
 * modules already enabled. These specs assert the section renders at every
 * ship-gate viewport, that the enabled state is reflected in each row's toggle,
 * and that toggling one off persists across a page reload.
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

/** A module's toggle, located by its accessible name rather than row classes. */
function moduleSwitch(page: Page, name: string) {
	return page.getByRole('switch', { name, exact: true })
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
				page.getByText('Extensions add object types and tabs for this workspace').first(),
			).toBeVisible()

			// The registered modules are listed with their names.
			await expect(page.getByText('Work', { exact: true }).first()).toBeVisible()
			await expect(page.getByText('CRM', { exact: true }).first()).toBeVisible()
			await expect(page.getByText('Knowledge', { exact: true }).first()).toBeVisible()

			// Default state: a new workspace ships with all three enabled.
			await expect(moduleSwitch(page, 'Work')).toBeChecked()
			await expect(moduleSwitch(page, 'CRM')).toBeChecked()
			await expect(moduleSwitch(page, 'Knowledge')).toBeChecked()
		})
	}

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`persists toggling an extension off and back on across reload at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await setTheme(page, 'light')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await openExtensionsPage(page, account.workspaceId)

			const crmSwitch = moduleSwitch(page, 'CRM')
			await expect(crmSwitch).toBeChecked({ timeout: 10000 })

			// Turning a module off asks for confirmation (its object types stop
			// being reachable), then persists.
			await crmSwitch.click()
			const confirm = page.getByRole('button', { name: 'Confirm removal' })
			// The dialog counts existing objects per affected type first; a fresh
			// workspace has none, which resolves every type and enables Confirm.
			await expect(confirm).toBeEnabled({ timeout: 10000 })
			await confirm.click()

			// Toggle state reflects the persisted workspace settings after refetch…
			await expect(crmSwitch).not.toBeChecked()
			// …and survives a full page reload.
			await page.reload()
			await expect(
				page.getByText('Extensions add object types and tabs for this workspace').first(),
			).toBeVisible({ timeout: 10000 })
			await expect(moduleSwitch(page, 'CRM')).not.toBeChecked()

			// Re-enabling restores it, and the module's statuses come back with it.
			await moduleSwitch(page, 'CRM').click()
			await expect(moduleSwitch(page, 'CRM')).toBeChecked()
			await page.reload()
			await expect(moduleSwitch(page, 'CRM')).toBeChecked({ timeout: 10000 })
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
				page.getByText('Extensions add object types and tabs for this workspace').first(),
			).toBeVisible()
			await expect(moduleSwitch(page, 'Work')).toBeChecked()
			await expect(moduleSwitch(page, 'CRM')).toBeChecked()
		}
	})
})
