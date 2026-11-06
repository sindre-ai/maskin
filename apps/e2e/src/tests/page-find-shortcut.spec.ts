import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Cmd+F / Ctrl+F focuses the current page's own search (Items, Flows, Agents, Marketplace,
// Chats, Search) and leaves the browser's find alone on pages without one (For you).
// The header has no workspace search button any more; ⌘K is the way to the launcher.

const PAGES = [
	{ path: 'objects', field: { role: 'searchbox', name: 'Search items' } },
	{ path: 'loops', field: { role: 'searchbox', name: 'Search flows' } },
	{ path: 'agents', field: { role: 'searchbox', name: 'Search agents' } },
	{ path: 'marketplace', field: { role: 'searchbox', name: 'Filter marketplace' } },
	{ path: 'chats', field: { role: 'searchbox', name: 'Search chats' } },
] as const

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Find shortcut at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		for (const { path, field } of PAGES) {
			test(`${path}: Ctrl+F focuses the page's own search`, async ({ page, account }) => {
				await page.goto(`/${account.workspaceId}/${path}`)
				const input = page.getByRole(field.role, { name: field.name })
				// From md the Chats screens draw their own top edge and the shared bar (and its
				// New button) steps aside, so the page's own search is the readiness signal there.
				const barless = path === 'chats' && vp.width >= 768
				await expect(
					barless ? input.last() : page.getByRole('button', { name: /^New/ }).first(),
				).toBeVisible({ timeout: 20_000 })
				await expect(page.getByRole('button', { name: 'Search or run a command' })).toHaveCount(0)

				await page.keyboard.press('Control+f')
				await expect(input.last()).toBeFocused()
			})
		}

		test('For you has no page search, so Ctrl+F is left to the browser', async ({
			page,
			account,
		}) => {
			await page.goto(`/${account.workspaceId}`)
			await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible({
				timeout: 20_000,
			})
			const prevented = await page.evaluate(() => {
				const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
				document.dispatchEvent(event)
				return event.defaultPrevented
			})
			expect(prevented).toBe(false)
		})

		test('Ctrl+K still opens the launcher', async ({ page, account }) => {
			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible({
				timeout: 20_000,
			})
			await page.keyboard.press('Control+k')
			await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
		})
	})
}
