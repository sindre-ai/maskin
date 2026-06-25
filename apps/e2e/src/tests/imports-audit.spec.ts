import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// AC-U5 — after a real import completes, the `/imports/$importId` page shows
// the per-row audit and the data-table toolbar History button takes the user
// there. Drives the full path end-to-end against the real backend.
test.describe('Imports audit — AC-U5', () => {
	test.beforeEach(async ({ account }) => {
		await account.api.updateWorkspace(account.workspaceId, {
			settings: {
				flags: { bulkImportDedup: true },
				statuses: { bet: ['signal', 'shape', 'active'] },
				field_definitions: { bet: [{ name: 'email', type: 'text' }] },
				display_names: { bet: 'Bet' },
			},
		})
	})

	test('toolbar History → /imports → detail audit, with one updated and one created row', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.desktop)

		// Seed one existing bet whose title we'll match in the CSV — drives an
		// "updated" audit row with `email` going from null → set.
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Existing Bet',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects`)
		await page
			.getByRole('button', { name: /^Import$/ })
			.first()
			.click()

		// Upload: one row matches an existing bet (update), one is new (create).
		// Scope the file-input lookup to the dialog — the page also mounts a
		// markdown upload input that would otherwise match.
		const csv = 'title,email\nExisting Bet,e@example.com\nBrand New Bet,n@example.com\n'
		await page
			.getByRole('dialog', { name: 'Import Objects' })
			.locator('input[type="file"]')
			.setInputFiles({
				name: 'data.csv',
				mimeType: 'text/csv',
				buffer: Buffer.from(csv),
			})

		await page.getByRole('button', { name: /Next: preview & match/ }).click()
		await page.getByRole('button', { name: /Dedup key title/ }).click()

		const runButton = page.getByRole('button', { name: /^Run import$/ })
		await expect(runButton).toBeEnabled({ timeout: 5000 })
		await runButton.click()

		// Background import is fast against the seeded workspace — wait for the
		// success toast as a deterministic "done" signal before navigating.
		await expect(page.getByText(/Import complete:/)).toBeVisible({ timeout: 30_000 })

		// AC-U5 part 1: the toolbar History link lands on /imports.
		await page.getByRole('link', { name: /imports history/i }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/imports$`))
		const importRow = page.getByRole('link', { name: /data\.csv/ }).first()
		await expect(importRow).toBeVisible()

		// AC-U5 part 2: clicking through shows the per-row audit with both a
		// created and an updated entry, and the updated entry surfaces the
		// `email` column with old → new.
		await importRow.click()
		await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/)

		const auditRows = page.getByTestId('audit-row')
		await expect(auditRows).toHaveCount(2)
		await expect(page.locator('[data-testid="audit-row"][data-action="created"]')).toHaveCount(1)
		const updatedRow = page.locator('[data-testid="audit-row"][data-action="updated"]')
		await expect(updatedRow).toHaveCount(1)
		await expect(updatedRow).toContainText('email')
		await expect(updatedRow).toContainText('e@example.com')
	})
})
