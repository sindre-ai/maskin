import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — Instructions section + edit modal', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`edits and saves the system prompt @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const original = 'Original instructions for the agent.'
			const edited = 'Edited instructions — trust the process.'

			const agent = await account.api.createAgentActor('Ivy Instructor')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.updateActor(agent.id, { system_prompt: original })

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const section = page.getByRole('region', { name: 'Instructions' })
			await expect(section).toBeVisible({ timeout: 10_000 })
			await expect(section.getByText('system prompt')).toBeVisible()
			await expect(section.getByText(original)).toBeVisible()

			await section.getByRole('button', { name: 'Edit' }).click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()
			await expect(
				dialog.getByText('Running sessions finish on the old prompt. New sessions pick this up.'),
			).toBeVisible()
			// Warning must be visible on touch viewports too (no hover-reveal).
			await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()

			// EDITED badge appears once the draft diverges from the saved value.
			await expect(dialog.getByText(/edited/i)).toBeHidden()
			const textarea = dialog.getByLabel('System prompt')
			await textarea.fill(edited)
			await expect(dialog.getByText(/edited/i)).toBeVisible()

			// Reset restores the saved value and clears the EDITED state.
			await dialog.getByRole('button', { name: /reset to default/i }).click()
			await expect(textarea).toHaveValue(original)
			await expect(dialog.getByText(/edited/i)).toBeHidden()

			// Edit again and save.
			await textarea.fill(edited)
			await dialog.getByRole('button', { name: 'Save' }).click()

			// Dialog closes.
			await expect(dialog).toBeHidden()

			// Persisted value shows on the surface after save.
			await expect(section.getByText(edited)).toBeVisible()

			// Round-trip through the API confirms the update landed.
			const refreshed = await account.api.getActor(agent.id)
			expect(refreshed.system_prompt).toBe(edited)

			// Reload — persisted value still shows (shipped-surface-probe).
			await page.reload()
			await expect(
				page.getByRole('region', { name: 'Instructions' }).getByText(edited),
			).toBeVisible()

			// Light and dark colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('region', { name: 'Instructions' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		test(`Cancel discards local edits @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const original = 'Hold the line.'
			const agent = await account.api.createAgentActor('Cass Cancel')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.updateActor(agent.id, { system_prompt: original })

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			const section = page.getByRole('region', { name: 'Instructions' })
			await expect(section).toBeVisible({ timeout: 10_000 })
			await section.getByRole('button', { name: 'Edit' }).click()

			const dialog = page.getByRole('dialog')
			await dialog.getByLabel('System prompt').fill('Never persisted.')
			await dialog.getByRole('button', { name: 'Cancel' }).click()
			await expect(dialog).toBeHidden()

			// Original persists on the surface and on the server.
			await expect(section.getByText(original)).toBeVisible()
			const refreshed = await account.api.getActor(agent.id)
			expect(refreshed.system_prompt).toBe(original)
		})
	}
})
