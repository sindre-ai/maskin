import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * No helper can produce a genuinely workspace-less actor: signup always creates
 * a workspace, the actor is its billing owner (so DELETE /workspaces/:id/members/:self
 * answers 409), and there is no workspace-delete route to call. Instead the
 * workspace LIST is stubbed to [] until the create POST succeeds; the create
 * itself hits the real backend (plan headroom granted so the trial ownership cap
 * does not reject it). A `TestAPI.leaveWorkspace` that works for a billing owner,
 * or a delete-account helper once PR #2181 lands, would let this use a real actor.
 */
async function stubEmptyWorkspaceList(page: Page) {
	let created = false
	page.on('response', (res) => {
		if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/workspaces') {
			created = res.ok()
		}
	})
	await page.route('**/api/workspaces', async (route) => {
		if (route.request().method() === 'GET' && !created) {
			await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
			return
		}
		await route.continue()
	})
}

test.describe('Create your first workspace', () => {
	test.describe.configure({ timeout: 60_000 })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test.describe(viewport.label, () => {
			test.use({ viewport: { width: viewport.width, height: viewport.height } })

			for (const scheme of ['light', 'dark'] as const) {
				test(`shows the screen instead of /signup and creates a workspace (${scheme})`, async ({
					page,
					account,
				}) => {
					await grantPlanHeadroom(account.apiKey, account.workspaceId)
					await page.emulateMedia({ colorScheme: scheme })
					await stubEmptyWorkspaceList(page)

					await page.goto('/')
					await expect(
						page.getByRole('heading', { name: 'Create your first workspace' }),
					).toBeVisible({ timeout: 30_000 })
					await expect(page).not.toHaveURL(/\/signup/)

					const create = page.getByRole('button', { name: 'Create workspace' })
					await expect(create).toBeDisabled()
					await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

					const name = `First ${Date.now()}`
					await page.getByLabel('Workspace name').fill(name)
					await create.click()

					await expect(page).toHaveURL(/\/[0-9a-f-]{36}(\/|$)/, { timeout: 30_000 })
					await expect(page).not.toHaveURL(/\/signup/)
				})
			}

			test('sign out returns to login', async ({ page, account }) => {
				await stubEmptyWorkspaceList(page)
				await page.goto('/')
				await page.getByRole('button', { name: 'Sign out' }).click()
				await expect(page).toHaveURL(/\/login/)
				expect(account.apiKey).toBeTruthy()
			})
		})
	}
})
