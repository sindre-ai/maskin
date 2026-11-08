import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const APPS = ['Claude Code', 'Cursor', 'VS Code', 'Claude Desktop', 'Other'] as const

async function gotoMcp(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/mcp`)
	// `load` instead of `networkidle` — the app holds an SSE connection to
	// /api/events, so networkidle never fires. Brief settle after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(300)
}

test.describe('Settings — MCP — one tab per app', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`lists the five apps, opens on Claude Code, and never overflows at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoMcp(page, account.workspaceId)

			const tabs = page.getByRole('tab')
			await expect(tabs).toHaveText([...APPS])
			await expect(page.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
				'aria-selected',
				'true',
			)
			await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveCount(0)

			for (const app of APPS) {
				await page.getByRole('tab', { name: app }).click()
				await expect(page.getByRole('tab', { name: app })).toHaveAttribute('aria-selected', 'true')
				// The page itself must never scroll sideways; the tab strip scrolls inside its own box.
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				)
				expect(overflow).toBeLessThanOrEqual(0)
			}
		})

		test(`keeps the active MCP item of the settings nav in view at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await gotoMcp(page, account.workspaceId)

			const nav = page.getByRole('navigation', { name: 'Settings sections' })
			const item = nav.getByRole('link', { name: 'MCP' })
			await expect(item).toBeVisible()
			await expect
				.poll(async () => {
					const navBox = await nav.boundingBox()
					const itemBox = await item.boundingBox()
					if (!navBox || !itemBox) return false
					const left = itemBox.x >= navBox.x - 1
					const right = itemBox.x + itemBox.width <= navBox.x + navBox.width + 1
					return left && right
				})
				.toBe(true)
		})
	}

	test('shows the Headers block on the Other tab only, and no key in the Server URL', async ({
		page,
		account,
	}) => {
		await gotoMcp(page, account.workspaceId)

		for (const app of APPS.filter((a) => a !== 'Other')) {
			await page.getByRole('tab', { name: app }).click()
			await expect(page.getByText('Headers', { exact: true })).toHaveCount(0)
		}

		await page.getByRole('tab', { name: 'Other' }).click()
		await expect(page.getByText('Headers', { exact: true })).toBeVisible()
		await expect(page.getByText(`X-Workspace-Id: ${account.workspaceId}`)).toBeVisible()

		const origin = new URL(page.url()).origin
		const serverUrl = page.getByText(`${origin}/mcp`, { exact: true })
		await expect(serverUrl).toBeVisible()
		expect(await serverUrl.textContent()).not.toContain(account.apiKey)
	})

	test('puts no API key in any link on the page', async ({ page, account }) => {
		await gotoMcp(page, account.workspaceId)

		for (const app of ['Cursor', 'VS Code']) {
			await page.getByRole('tab', { name: app }).click()
			const hrefs = await page
				.getByRole('tabpanel')
				.locator('a[href]')
				.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
			for (const href of hrefs) expect(href).not.toContain(account.apiKey)
		}
	})

	test('keeps file-name block labels in their written case', async ({ page, account }) => {
		await gotoMcp(page, account.workspaceId)

		await page.getByRole('tab', { name: 'Cursor' }).click()
		await expect(page.getByText('~/.cursor/mcp.json', { exact: true })).toHaveCSS(
			'text-transform',
			'none',
		)

		await page.getByRole('tab', { name: 'Claude Desktop' }).click()
		await expect(page.getByText('claude_desktop_config.json', { exact: true })).toHaveCSS(
			'text-transform',
			'none',
		)

		await page.getByRole('tab', { name: 'Other' }).click()
		await expect(page.getByText('Server URL', { exact: true })).toHaveCSS(
			'text-transform',
			'uppercase',
		)
	})

	test('copies the Claude Code command with the key and flips the button to Copied', async ({
		page,
		account,
		context,
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write'])
		await gotoMcp(page, account.workspaceId)

		await page.getByRole('button', { name: 'Copy' }).click()
		await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
		await expect(page.getByText('Copied with your API key')).toBeVisible()

		const copied = await page.evaluate(() => navigator.clipboard.readText())
		expect(copied).toContain('claude mcp add --transport http maskin')
		expect(copied).toContain(`Authorization: Bearer ${account.apiKey}`)
		expect(copied).toContain(`X-Workspace-Id: ${account.workspaceId}`)
	})

	test('shows the sign out and back in notice and disables the install buttons with no key', async ({
		page,
		account,
	}) => {
		await gotoMcp(page, account.workspaceId)
		// A reload would bounce to /login (the route guard needs a key), so drop the key in place
		// and let the next tab switch re-render the page without one.
		await page.evaluate(() => localStorage.removeItem('maskin-api-key'))

		await page.getByRole('tab', { name: 'Cursor' }).click()
		await expect(page.getByRole('alert').filter({ hasText: 'Sign out and back in' })).toBeVisible()
		await expect(page.getByRole('button', { name: 'Add to Cursor' })).toBeDisabled()

		await page.getByRole('tab', { name: 'VS Code' }).click()
		await expect(page.getByRole('button', { name: 'Add to VS Code' })).toBeDisabled()
	})
})
