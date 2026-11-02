import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings → Notifications: the caller's push preferences. Real stack, no stubs.
 * "Needs you" is shown but locked; every other row is a switch that persists.
 */

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Notifications switches persist across a reload and never overflow @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.goto(`/${account.workspaceId}/settings/notifications`)

		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible({
			timeout: 15_000,
		})
		await expect(page.getByText('Choose what reaches you, and where.')).toBeVisible()
		await expect(page.getByText('Ignores quiet hours.')).toBeVisible()
		await expect(page.getByRole('switch', { name: 'Needs you', exact: true })).toBeDisabled()

		const digests = page.getByRole('switch', { name: 'Digests', exact: true })
		await expect(digests).toBeChecked()
		await digests.click()
		await expect(digests).not.toBeChecked()

		await page.reload()
		await expect(page.getByRole('switch', { name: 'Digests', exact: true })).not.toBeChecked({
			timeout: 15_000,
		})

		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		).toBe(false)
	})
}

test('Notifications reads in light and dark', async ({ page, account }) => {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme })
		await page.goto(`/${account.workspaceId}/settings/notifications`)
		await expect(page.getByRole('switch', { name: 'Chat replies', exact: true })).toBeVisible({
			timeout: 15_000,
		})
		await expect(page.getByText('Daily briefing at')).toBeVisible()
	}
})
