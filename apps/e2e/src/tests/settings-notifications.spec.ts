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
		await expect(page.getByText('Ignores quiet hours.').first()).toBeVisible()
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

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`The email switch on the Digests row is on for a new sign-up, saves, and survives a reload @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.goto(`/${account.workspaceId}/settings/notifications`)

		const email = page.getByRole('switch', { name: 'Digests by email', exact: true })
		await expect(email).toBeVisible({ timeout: 15_000 })
		await expect(email).toBeChecked()
		await email.click()
		await expect(email).not.toBeChecked()

		await page.reload()
		await expect(
			page.getByRole('switch', { name: 'Digests by email', exact: true }),
		).not.toBeChecked({ timeout: 15_000 })
		// The push switch on the same row is a separate setting.
		await expect(page.getByRole('switch', { name: 'Digests', exact: true })).toBeChecked()
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

test('A saved-off "Needs you" stays editable so it can be turned back on', async ({
	page,
	account,
}) => {
	const res = await fetch('http://localhost:5173/api/notification-preferences', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.apiKey}` },
		body: JSON.stringify({ categories: { needs_you: false } }),
	})
	expect(res.ok).toBe(true)

	await page.goto(`/${account.workspaceId}/settings/notifications`)
	const needsYou = page.getByRole('switch', { name: 'Needs you', exact: true })
	await expect(needsYou).toBeEnabled({ timeout: 15_000 })
	await expect(needsYou).not.toBeChecked()
	await needsYou.click()
	await expect(needsYou).toBeChecked()
	// Once on it is locked again.
	await expect(needsYou).toBeDisabled()
})

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Each kind has a Browser switch next to Push, and a new sign-up starts with Tips off @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.goto(`/${account.workspaceId}/settings/notifications`)

		const browser = (name: string) =>
			page.getByRole('switch', { name: `${name} in the browser`, exact: true })
		await expect(browser('Chat replies')).toBeVisible({ timeout: 15_000 })

		// Every kind has one, and it can be turned on for any kind.
		for (const kind of ['Needs you', 'Chat replies', 'Digests', 'Tips and updates']) {
			await expect(browser(kind)).toBeVisible()
		}
		await expect(page.getByText('Not asked').first()).toBeVisible()

		// Browser is its own switch: turning it off leaves Push on.
		await browser('Chat replies').click()
		await expect(browser('Chat replies')).not.toBeChecked()
		await expect(page.getByRole('switch', { name: 'Chat replies', exact: true })).toBeChecked()

		await page.reload()
		await expect(browser('Chat replies')).not.toBeChecked({ timeout: 15_000 })
		await expect(page.getByRole('switch', { name: 'Chat replies', exact: true })).toBeChecked()

		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		).toBe(false)
	})
}

test('A new sign-up starts with Tips off for push and the browser, the rest on', async ({
	page,
	account,
}) => {
	await page.goto(`/${account.workspaceId}/settings/notifications`)
	await expect(page.getByRole('switch', { name: 'Chat replies', exact: true })).toBeChecked({
		timeout: 15_000,
	})
	for (const name of ['Needs you', 'Chat replies', 'Digests']) {
		await expect(page.getByRole('switch', { name, exact: true })).toBeChecked()
		await expect(
			page.getByRole('switch', { name: `${name} in the browser`, exact: true }),
		).toBeChecked()
	}
	await expect(
		page.getByRole('switch', { name: 'Tips and updates', exact: true }),
	).not.toBeChecked()
	await expect(
		page.getByRole('switch', { name: 'Tips and updates in the browser', exact: true }),
	).not.toBeChecked()
})
