import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings pages restyled to web v3: Integrations (state pills, pill actions, Tool servers,
 * Import from Claude), Members (flat list, role pill) and MCP. Real stack, no stubs.
 */

const SERVER = { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] }

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Integrations shows tool servers with 44px actions on touch @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await account.api.createCustomMcpServer(account.workspaceId, 'Docs search', SERVER)

		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const tools = page.getByRole('region', { name: 'Tool servers' })
		await expect(tools).toBeVisible({ timeout: 15_000 })
		await expect(tools.getByRole('button', { name: /Docs search/ })).toBeVisible()

		const add = tools.getByRole('button', { name: /Add your own MCP server/ })
		await expect(add).toBeVisible()
		if (vp.width < 768) {
			const box = await add.boundingBox()
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
		}

		await tools.getByRole('button', { name: /Import from Claude/ }).click()
		await expect(page.getByRole('dialog', { name: 'Import from Claude' })).toBeVisible()
		await page.keyboard.press('Escape')

		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		).toBe(false)
	})

	test(`Members lists the owner with a role and an Add member action @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		await page.goto(`/${account.workspaceId}/settings/members`)
		await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible({ timeout: 15_000 })
		await expect(page.getByText('owner', { exact: true })).toBeVisible()

		await page.getByRole('button', { name: /Add member/ }).click()
		await page.getByRole('menuitem', { name: 'Invite member' }).click()
		await expect(page.getByRole('dialog', { name: 'Invite member' })).toBeVisible()

		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		).toBe(false)
	})
}

test('Integrations and Members read in light and dark', async ({ page, account }) => {
	await account.api.createCustomMcpServer(account.workspaceId, 'Docs search', SERVER)
	for (const scheme of ['light', 'dark'] as const) {
		await page.addInitScript((value) => localStorage.setItem('maskin-theme', value), scheme)
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const tools = page.getByRole('region', { name: 'Tool servers' })
		await expect(tools.getByRole('button', { name: /Docs search/ })).toBeVisible({
			timeout: 15_000,
		})
		await expect(tools.getByRole('button', { name: /Add your own MCP server/ })).toBeVisible()

		await page.goto(`/${account.workspaceId}/settings/members`)
		await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
	}
})
