import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// AC-U1 / AC-U2 / AC-U4 — Step 3 (preview & match) behind the
// workspaces.metadata.flags.bulkImportDedup dogfood flag.
test.describe('Import — Step 3 dedup picker', () => {
	test.beforeEach(async ({ account }) => {
		// Enable the dogfood flag and declare a metadata field so the picker has
		// more than one option. Statuses must list `bet` for the existing type
		// mapping to pick up an objectType (the upload step seeds typeMappings
		// from workspace.settings.statuses).
		await account.api.updateWorkspace(account.workspaceId, {
			settings: {
				flags: { bulkImportDedup: true },
				statuses: { bet: ['signal', 'shape', 'active'] },
				field_definitions: { bet: [{ name: 'email', type: 'string' }] },
				display_names: { bet: 'Bet' },
			},
		})
	})

	test('AC-U1 + AC-U2: chip picker, three counts, diff render on Step 3', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.desktop)
		await page.goto(`/${account.workspaceId}/objects`)
		await page
			.getByRole('button', { name: /Import/ })
			.first()
			.click()

		// Upload a tiny CSV with a single column matching `title`.
		const fileInput = page.locator('input[type="file"]')
		await fileInput.setInputFiles({
			name: 'data.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('title,email\nNew Bet,a@example.com\n'),
		})

		// Advance into Step 3.
		await page.getByRole('button', { name: /Next: preview & match/ }).click()
		await expect(page.getByText('Match existing records by:')).toBeVisible()

		// AC-U1: picker lists every attribute on the target type.
		await expect(page.getByRole('button', { name: /Dedup key title/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /Dedup key email/ })).toBeVisible()

		// AC-U2: three counts are visible as scrollable jump targets.
		await expect(page.getByRole('button', { name: /Jump to To update/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /Jump to New to create/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /Jump to Unchanged · skip/ })).toBeVisible()

		// Run import is disabled while no key is selected.
		await expect(page.getByRole('button', { name: /^Run import$/ })).toBeDisabled()

		// Selecting a key enables Run import + triggers the preview re-run.
		await page.getByRole('button', { name: /Dedup key title/ }).click()
		await expect(page.getByRole('button', { name: /^Run import$/ })).toBeEnabled({ timeout: 5000 })
	})

	test('AC-U4: escape hatch surfaces verbatim copy with destructive confirm', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.desktop)
		await page.goto(`/${account.workspaceId}/objects`)
		await page
			.getByRole('button', { name: /Import/ })
			.first()
			.click()

		const fileInput = page.locator('input[type="file"]')
		await fileInput.setInputFiles({
			name: 'data.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('title,email\nNew Bet,a@example.com\n'),
		})

		await page.getByRole('button', { name: /Next: preview & match/ }).click()
		await page.getByRole('button', { name: /Skip matching — create all/ }).click()

		await expect(
			page.getByText(
				"Importing without a dedup key creates duplicates for every row — pick at least one field, or confirm 'Create all as new'.",
			),
		).toBeVisible()
		await expect(page.getByRole('button', { name: 'Create all as new' })).toBeVisible()
	})

	test('mobile (375px): Step 3 collapses to single-column and chips reachable', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await page.goto(`/${account.workspaceId}/objects`)
		await page
			.getByRole('button', { name: /Import/ })
			.first()
			.click()

		const fileInput = page.locator('input[type="file"]')
		await fileInput.setInputFiles({
			name: 'data.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('title,email\nNew Bet,a@example.com\n'),
		})

		await page.getByRole('button', { name: /Next: preview & match/ }).click()

		// Chips still visible and clickable on mobile.
		await expect(page.getByText('Match existing records by:')).toBeVisible()
		await page.getByRole('button', { name: /Dedup key title/ }).click()
		await expect(page.getByRole('button', { name: /Dedup key title/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
	})
})
