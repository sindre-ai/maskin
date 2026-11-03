import type { Locator, Page } from '@playwright/test'

/**
 * Send whatever is typed in a chat Composer the way a user at this viewport
 * would. Below 768px the composer treats Enter as a newline (a phone soft
 * keyboard has no Shift key), so the visible send button is the send gesture;
 * at 768px and up Enter still sends.
 */
export async function sendFromComposer(page: Page, composer: Locator, viewportWidth: number) {
	if (viewportWidth < 768) {
		await page.getByRole('button', { name: 'Send message' }).click()
	} else {
		await composer.press('Enter')
	}
}
