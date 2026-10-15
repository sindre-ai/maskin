import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Delete workspace (Settings > General, billing owner only) and delete account (Profile).
// Both are destructive and confirmed in a dialog: the workspace by typing its name back, the
// account by re-entering the password. Every test creates its own actor via the fixture.

const PASSWORD = 'e2e-test-password-123'

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

test.describe('Delete workspace', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		for (const theme of ['light', 'dark'] as const) {
			test(`confirms by typed name and leaves the workspace at ${viewport.label} (${theme})`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await setTheme(page, theme)
				const doomed = await account.api.createWorkspace(`Doomed ${Date.now()}`)

				await page.goto(`/${doomed.id}/settings`)
				await page.getByRole('button', { name: 'Delete workspace' }).click()

				const dialog = page.getByRole('dialog')
				await expect(dialog).toBeVisible()
				const confirm = dialog.getByRole('button', { name: 'Delete workspace' })
				await expect(confirm).toBeDisabled()

				await dialog.getByLabel(/Type .* to confirm/).fill('not the name')
				await expect(confirm).toBeDisabled()

				await dialog.getByLabel(/Type .* to confirm/).fill(doomed.name)
				await expect(confirm).toBeEnabled()
				await confirm.click()

				await expect(page).not.toHaveURL(new RegExp(doomed.id), { timeout: 15_000 })
				const remaining = await account.api.listWorkspaces()
				expect(remaining.map((w) => w.id)).not.toContain(doomed.id)
				expect(remaining.map((w) => w.id)).toContain(account.workspaceId)
			})
		}
	}

	test('is not offered to a member who is not the billing owner', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.addInitScript(() => {
			const actor = JSON.parse(localStorage.getItem('maskin-actor') ?? '{}')
			localStorage.setItem('maskin-actor', JSON.stringify({ ...actor, id: 'someone-else' }))
		})
		await page.goto(`/${account.workspaceId}/settings`)
		await expect(page.getByRole('heading', { name: 'WORKSPACE NAME' })).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByRole('button', { name: 'Delete workspace' })).toHaveCount(0)
	})
})

test.describe('Delete account', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		for (const theme of ['light', 'dark'] as const) {
			test(`rejects a wrong password, then deletes and signs out at ${viewport.label} (${theme})`, async ({
				page,
				account,
			}) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height })
				await setTheme(page, theme)
				await page.goto(`/${account.workspaceId}/profile`)

				await page.getByRole('button', { name: 'Delete account' }).click()
				const dialog = page.getByRole('dialog')
				await expect(dialog).toBeVisible()

				// The fixture's workspace has no one else in it, so the sole-workspace choice is offered.
				await expect(dialog.getByRole('checkbox')).toBeVisible({ timeout: 10_000 })
				await dialog.getByRole('checkbox').click()

				const confirm = dialog.getByRole('button', { name: 'Delete account' })
				await expect(confirm).toBeDisabled()

				await dialog.getByLabel('Enter your password to confirm').fill('wrong-password')
				await confirm.click()
				await expect(dialog.getByText('Wrong password.')).toBeVisible()
				await expect(page).toHaveURL(/\/profile$/)

				await dialog.getByLabel('Enter your password to confirm').fill(PASSWORD)
				await confirm.click()

				await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
				expect(await page.evaluate(() => localStorage.getItem('maskin-api-key'))).toBeNull()
			})
		}
	}
})
