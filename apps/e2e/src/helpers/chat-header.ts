import type { Locator, Page } from '@playwright/test'

/**
 * The chat header keeps Rename, Copy, Pin, Mark as unread, Archive, the list focus toggle and
 * Close behind its `···` menu (web v11). Opens the menu and returns the item, so a spec can
 * click it or assert its state; the menu closes on its own when an item is chosen.
 */
export async function headerMenuItem(page: Page, name: string): Promise<Locator> {
	const item = page.getByRole('menuitem', { name })
	if (!(await item.isVisible().catch(() => false))) {
		await page.getByRole('button', { name: 'More actions' }).click()
	}
	return item
}
