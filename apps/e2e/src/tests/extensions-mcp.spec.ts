import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Connect an MCP on a custom extension (bring-your-own integrations): the Add
 * an MCP modal, the tools probe, the 20-tool cap and the saved summary. The
 * surface sits behind the byo-extensions-ui flag, so the specs use the
 * client-side test override. The extension and the save go through the real
 * /api; only the tools probe is answered in the browser, because it would
 * otherwise call out to a vendor on the internet.
 */

async function enableFlag(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:byo-extensions-ui', 'on')
	})
}

async function stubProbe(page: Page, toolCount: number) {
	await page.route('**/api/extensions/mcp/probe', (route) =>
		route.fulfill({
			json: {
				ok: true,
				tools: Array.from({ length: toolCount }, (_, i) => ({
					name: i === 0 ? 'bookmark_meeting' : `get_item_${String(i).padStart(2, '0')}`,
					kind: i === 0 ? 'write' : 'read',
				})),
			},
		}),
	)
}

async function seedDraft(page: Page, apiKey: string, workspaceId: string, name: string) {
	const res = await page.request.post('/api/extensions', {
		headers: { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId },
		data: { slug: `acme-${Date.now()}`, name, status: 'draft' },
	})
	expect(res.status()).toBe(201)
	return ((await res.json()) as { id: string }).id
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`extension MCP at ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('verifies a server, saves the ticked tools and shows the masked key', async ({
			page,
			account,
		}) => {
			await enableFlag(page)
			await stubProbe(page, 3)
			const extName = `Acme ${Date.now()}`
			const extId = await seedDraft(page, account.apiKey, account.workspaceId, extName)

			await page.goto(`/${account.workspaceId}/settings/extensions/${extId}`)
			await expect(page.getByRole('heading', { name: 'MCP tools' })).toBeVisible()
			await page.getByRole('button', { name: 'Add MCP' }).click()

			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Add an MCP')).toBeVisible()
			await expect(dialog.getByRole('radio', { name: /OAuth 2.1/ })).toBeDisabled()
			await dialog.getByLabel('Server URL').fill('https://mcp.example.com/mcp')
			await dialog.getByLabel('API key', { exact: true }).fill('sk-test-key-123')
			await dialog.getByRole('button', { name: 'Verify & save' }).click()

			await expect(dialog.getByText('Selected: 3/20')).toBeVisible()
			await dialog.getByRole('checkbox', { name: 'bookmark_meeting', exact: true }).uncheck()
			await expect(dialog.getByText('Selected: 2/20')).toBeVisible()
			await dialog.getByRole('button', { name: 'Save' }).click()
			await expect(dialog).toBeHidden()

			// Saved: the summary reads On, the key is masked, and it survives a reload.
			await page.reload()
			await expect(page.getByText('On · 2 tools')).toBeVisible()
			await expect(page.getByLabel('API key (hidden)')).toBeVisible()
			await expect(page.getByText('sk-test-key-123')).toHaveCount(0)
			await expect(page.getByRole('region', { name: 'Setup progress' })).toContainText(/MCP\s*done/)
		})

		test('pre-ticks 20 of 21 tools and blocks Save one above the cap', async ({
			page,
			account,
		}) => {
			await enableFlag(page)
			await stubProbe(page, 21)
			const extId = await seedDraft(page, account.apiKey, account.workspaceId, `Acme ${Date.now()}`)

			await page.goto(`/${account.workspaceId}/settings/extensions/${extId}`)
			await page.getByRole('button', { name: 'Add MCP' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.getByLabel('Server URL').fill('https://mcp.example.com/mcp')
			await dialog.getByLabel('API key', { exact: true }).fill('sk-test-key-123')
			await dialog.getByRole('button', { name: 'Verify & save' }).click()

			await expect(dialog.getByText('Selected: 20/20')).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
			await dialog.getByRole('checkbox', { name: 'get_item_20', exact: true }).check()
			await expect(dialog.getByText('Selected: 21/20')).toBeVisible()
			await expect(dialog.getByRole('alert')).toContainText('Cap is 20')
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
		})
	})
}

test.describe('extension MCP error band', () => {
	test('keeps the modal open and saves nothing when the server rejects the key', async ({
		page,
		account,
	}) => {
		await enableFlag(page)
		await page.route('**/api/extensions/mcp/probe', (route) =>
			route.fulfill({
				json: { ok: false, reason: 'rejected', message: 'The server rejected the API key.' },
			}),
		)
		const extName = `Acme ${Date.now()}`
		const extId = await seedDraft(page, account.apiKey, account.workspaceId, extName)

		await page.goto(`/${account.workspaceId}/settings/extensions/${extId}`)
		await page.getByRole('button', { name: 'Add MCP' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByLabel('Server URL').fill('https://mcp.example.com/mcp')
		await dialog.getByLabel('API key', { exact: true }).fill('wrong-key')
		await dialog.getByRole('button', { name: 'Verify & save' }).click()

		await expect(dialog.getByText(`Couldn't verify ${extName} MCP`)).toBeVisible()
		await expect(dialog.getByText(/Nothing was saved/)).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Declare tools by hand' })).toBeVisible()

		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await page.reload()
		await expect(page.getByRole('button', { name: 'Add MCP' })).toBeVisible()
	})
})
