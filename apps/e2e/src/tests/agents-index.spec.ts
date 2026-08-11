import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agents index', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`grouped sections and Display-menu status filter @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)
			const brian = await account.api.createAgentActor('Brian Bot')
			await account.api.addWorkspaceMember(account.workspaceId, brian.id)

			await page.goto(`/${account.workspaceId}/agents`)

			// With no sessions seeded both agents land in Idle; Working and
			// Failed keep their per-group empty states.
			await expect(page.getByRole('link', { name: 'Ada Atom' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('link', { name: 'Brian Bot' })).toBeVisible()
			await expect(page.getByRole('heading', { name: /^Working$/ })).toBeVisible()
			await expect(page.getByText('No working agents')).toBeVisible()
			await expect(page.getByText('No failed agents')).toBeVisible()

			// The grouped sections and agent rows render in both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('heading', { name: /^Idle$/ })).toBeVisible()
				await expect(page.getByRole('link', { name: 'Ada Atom' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Filter to Idle via the Display menu — Working/Failed disappear —
			// and the status choice survives a reload via per-actor persistence.
			await page.getByRole('button', { name: 'Display', exact: true }).click()
			await page.getByRole('button', { name: /\+ status/i }).click()
			// Register before the toggle so the debounced 500ms write-through
			// cannot be missed.
			const settingsSaved = page.waitForResponse(
				(r) => r.url().includes('/user-display-settings/agents') && r.request().method() === 'PUT',
			)
			await page.getByRole('menuitemcheckbox', { name: 'idle' }).click()
			await settingsSaved

			await expect(page.getByRole('heading', { name: /^Working$/ })).not.toBeVisible()
			await expect(page.getByRole('heading', { name: /^Failed$/ })).not.toBeVisible()
			await expect(page.getByRole('link', { name: 'Ada Atom' })).toBeVisible()

			await page.reload()
			await expect(page.getByRole('link', { name: 'Ada Atom' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('heading', { name: /^Idle$/ })).toBeVisible()
			await expect(page.getByRole('heading', { name: /^Working$/ })).not.toBeVisible()
		})
	}
})
