import type { Page } from '@playwright/test'

/**
 * Opens the mobile sidebar drawer via the header's SidebarTrigger, if present.
 *
 * Uses `waitFor({ state: 'visible' })` rather than a one-shot `count()`/`isVisible()`
 * check — on a cold dev-server page load the trigger may not have mounted yet at the
 * instant this runs, and a non-waiting check would silently skip the click.
 */
export async function openSidebarOnMobile(page: Page) {
	const trigger = page.getByRole('button', { name: /toggle sidebar/i }).first()
	try {
		await trigger.waitFor({ state: 'visible', timeout: 5_000 })
	} catch {
		return
	}
	await trigger.click()
}
