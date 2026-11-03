import type { Page } from '@playwright/test'

/** The app's own mobile cutoff (`use-mobile.ts`). Below it the sidebar is a
 *  drawer that must be opened; at or above it the sidebar is already on screen. */
const MOBILE_BREAKPOINT = 768

/**
 * Opens the mobile sidebar drawer via the header's SidebarTrigger, if present.
 *
 * Only below the mobile breakpoint. Above it there is nothing to open, and
 * clicking anyway is actively harmful: `SidebarRail` — the 4px drag edge at the
 * sidebar's border — is also named "Toggle Sidebar" and is visible from `sm:`
 * up, so a viewport-blind click lands on it and *collapses* the sidebar that
 * the caller was trying to reveal. That went unnoticed while the pre-v2
 * switcher kept its "Switch workspace" name in the collapsed state; the v2 one
 * swaps to the rail's "Expand sidebar", so the collapse now fails the spec
 * rather than passing by accident.
 *
 * Uses `waitFor({ state: 'visible' })` rather than a one-shot `count()`/`isVisible()`
 * check — on a cold dev-server page load the trigger may not have mounted yet at the
 * instant this runs, and a non-waiting check would silently skip the click.
 */
export async function openSidebarOnMobile(page: Page) {
	const width = page.viewportSize()?.width
	if (width !== undefined && width >= MOBILE_BREAKPOINT) return

	// Scoped to the app header: the rail carries the same accessible name.
	const trigger = page
		.locator('header')
		.getByRole('button', { name: /toggle sidebar/i })
		.first()
	try {
		await trigger.waitFor({ state: 'visible', timeout: 5_000 })
	} catch {
		return
	}
	await trigger.click()
}
