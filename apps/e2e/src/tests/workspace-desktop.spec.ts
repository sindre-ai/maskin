import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for the workspace desktop screen (`/$workspaceId/desktop`),
 * gated behind the `workspace-desktop` flag.
 *
 * CI has no agent-server or microVM, so the desktop itself is faked at the two
 * network edges the page touches: `POST /api/desktop/connect` and the
 * `/api/desktop/stream` WebSocket. What this spec proves is the page's wiring
 * and layout — flag boundary, ticket hand-off, error and retry states, and no
 * horizontal overflow at the ship-gate viewports. The live VNC picture is
 * covered by the manual run documented in docker/desktop-test/README.md.
 */

const FLAG_KEY = 'ff:workspace-desktop'

async function setFlag(page: Page, value: 'on' | 'off') {
	await page.addInitScript(
		({ key, v }) => {
			localStorage.setItem(key, v)
		},
		{ key: FLAG_KEY, v: value },
	)
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('Workspace desktop', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows a retryable error when the desktop cannot start at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await setFlag(page, 'on')
			let connectCalls = 0
			await page.route('**/api/desktop/connect', async (route) => {
				connectCalls += 1
				await route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({
						error: { code: 'INTERNAL_ERROR', message: 'No desktop could be started' },
					}),
				})
			})

			await page.goto(`/${account.workspaceId}/desktop`)

			await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
			const reconnect = page.getByRole('button', { name: 'Reconnect' })
			await expect(reconnect).toBeVisible()
			await expectNoHorizontalOverflow(page)

			await reconnect.click()
			await expect.poll(() => connectCalls).toBe(2)
		})

		test(`shows the starting state while the desktop boots at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await setFlag(page, 'on')
			// Never fulfilled: the page stays in its first-start state.
			await page.route('**/api/desktop/connect', () => {})

			await page.goto(`/${account.workspaceId}/desktop`)

			await expect(page.getByText('Starting your desktop')).toBeVisible()
			await expect(page.getByText(/first start can take up to a minute/i)).toBeVisible()
			await expectNoHorizontalOverflow(page)
		})
	}

	test('opens the stream WebSocket with the one-time ticket from connect', async ({
		page,
		account,
	}) => {
		await setFlag(page, 'on')
		await page.route('**/api/desktop/connect', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ticket: 'e2e-ticket',
					path: '/api/desktop/stream',
					password: 'e2e-password',
				}),
			})
		})
		const streamUrl = new Promise<string>((resolve) => {
			void page.routeWebSocket(/\/api\/desktop\/stream/, (ws) => {
				resolve(ws.url())
				// Close before any VNC handshake: the page must report it never came up.
				void ws.close()
			})
		})

		await page.goto(`/${account.workspaceId}/desktop`)

		const url = new URL(await streamUrl)
		expect(url.pathname).toBe('/api/desktop/stream')
		expect(url.searchParams.get('ticket')).toBe('e2e-ticket')
		await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
	})

	test('is unavailable and unlisted when the flag is off', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await setFlag(page, 'off')
		let connectCalls = 0
		await page.route('**/api/desktop/connect', async (route) => {
			connectCalls += 1
			await route.abort()
		})

		await page.goto(`/${account.workspaceId}/desktop`)

		await expect(page.getByText("Desktop isn't available yet")).toBeVisible()
		await expect(page.getByRole('link', { name: 'Desktop' })).toHaveCount(0)
		expect(connectCalls).toBe(0)
	})

	test('is listed in the sidebar when the flag is on', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await setFlag(page, 'on')
		await page.route('**/api/desktop/connect', () => {})

		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByRole('link', { name: 'Desktop' })).toBeVisible()
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`renders its status and error state in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await setFlag(page, 'on')
			await page.route('**/api/desktop/connect', async (route) => {
				await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
			})

			await page.goto(`/${account.workspaceId}/desktop`)

			await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
			await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
		})
	}
})
