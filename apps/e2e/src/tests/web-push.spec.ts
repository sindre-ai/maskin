import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Browser notifications toggle on Profile.
//
// What this spec can and cannot prove. Headless Chromium has no route to a real push service, so
// the Push API in the page is replaced by an in-memory fake (installed before the app boots) and
// `/api/web-push/config` is stubbed so the toggle appears without server-side VAPID keys. The
// subscribe/unsubscribe calls still go to the REAL backend and database. Actual delivery to
// Chrome / Edge / Safari is verified by hand against real push services — see the bet's
// verification section — because a fake push service can only echo our own assumptions.

const VAPID_PUBLIC_KEY = `B${'A'.repeat(86)}`

async function installFakePushApi(page: Page, opts: { permission: NotificationPermission }) {
	await page.addInitScript(
		({ initialPermission }) => {
			// A browser keeps its permission across a reload, like the subscription below.
			const PERMISSION_KEY = 'e2e-fake-push-permission'
			let permission = (sessionStorage.getItem(PERMISSION_KEY) ??
				initialPermission) as NotificationPermission
			const KEY = 'e2e-fake-push-subscription'
			const read = () => sessionStorage.getItem(KEY)
			const makeSub = (endpoint: string) => ({
				endpoint,
				toJSON() {
					return {
						endpoint,
						keys: {
							p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u',
							auth: 'tBHItJI5svbpez7KI4CCXg',
						},
					}
				},
				async unsubscribe() {
					sessionStorage.removeItem(KEY)
					return true
				},
			})
			const registration = {
				pushManager: {
					async getSubscription() {
						const endpoint = read()
						return endpoint ? makeSub(endpoint) : null
					},
					async subscribe() {
						const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`
						sessionStorage.setItem(KEY, endpoint)
						return makeSub(endpoint)
					},
				},
			}
			Object.defineProperty(navigator, 'serviceWorker', {
				configurable: true,
				value: {
					register: async () => registration,
					getRegistration: async () => registration,
					ready: Promise.resolve(registration),
				},
			})
			;(window as unknown as { PushManager: unknown }).PushManager = function PushManager() {}
			Object.defineProperty(Notification, 'permission', {
				configurable: true,
				get: () => permission,
			})
			Notification.requestPermission = async () => {
				if (permission === 'default') permission = 'granted'
				sessionStorage.setItem(PERMISSION_KEY, permission)
				return permission
			}
		},
		{ initialPermission: opts.permission },
	)
	await page.route('**/api/web-push/config', (route) =>
		route.fulfill({ json: { enabled: true, public_key: VAPID_PUBLIC_KEY } }),
	)
}

const toggle = (page: Page) => page.getByRole('switch', { name: 'Browser notifications' })

test.describe('Browser notifications', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`turns on and off from Profile at ${viewport.label}`, async ({ page, account }) => {
			await installFakePushApi(page, { permission: 'default' })
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/profile`)

			await expect(toggle(page)).toBeVisible({ timeout: 10_000 })
			await expect(toggle(page)).not.toBeChecked()

			const subscribed = page.waitForResponse(
				(r) => r.url().endsWith('/api/web-push/subscriptions') && r.request().method() === 'POST',
			)
			await toggle(page).click()
			expect((await subscribed).status()).toBe(200)
			await expect(toggle(page)).toBeChecked()

			// The browser is the source of truth, so it stays on after a reload.
			await page.reload()
			await expect(toggle(page)).toBeChecked({ timeout: 10_000 })

			const unsubscribed = page.waitForResponse(
				(r) =>
					/\/api\/web-push\/subscriptions\/[0-9a-f-]{36}$/.test(r.url()) &&
					r.request().method() === 'DELETE',
			)
			await toggle(page).click()
			expect((await unsubscribed).status()).toBe(200)
			await expect(toggle(page)).not.toBeChecked()
		})
	}

	test('is reachable and legible in light and dark mode', async ({ page, account }) => {
		await installFakePushApi(page, { permission: 'default' })
		await page.setViewportSize({ width: 375, height: 812 })
		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}/profile`)
			await expect(toggle(page)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('Browser notifications', { exact: true })).toBeVisible()
		}
	})

	test('shows the toggle disabled when the browser has blocked notifications', async ({
		page,
		account,
	}) => {
		await installFakePushApi(page, { permission: 'denied' })
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)
		await expect(toggle(page)).toBeDisabled({ timeout: 10_000 })
		await expect(page.getByText('Blocked in site settings')).toBeVisible()
	})

	test('hides the whole section when the server has no VAPID keys', async ({ page, account }) => {
		await installFakePushApi(page, { permission: 'default' })
		await page.route('**/api/web-push/config', (route) =>
			route.fulfill({ json: { enabled: false, public_key: null } }),
		)
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/profile`)
		await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 10_000 })
		await expect(toggle(page)).toHaveCount(0)
		await expect(page.getByText('Notifications', { exact: true })).toHaveCount(0)
	})
})
