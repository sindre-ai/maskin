import { expect, test } from '../fixtures/auth.fixture'

test.describe('Objects CRUD', () => {
	test('can create an object via the header New menu', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)

		// Header "New" menu → "New task" opens the CreatePicker dialog pre-seeded
		// to the task subtype, so no type-selector step is shown.
		// The objects list toolbar has its own "New" button too — scope to the
		// global header so this exercises the header's New menu specifically.
		await page.locator('header').getByRole('button', { name: /^new$/i }).click()
		await page.getByRole('menuitem', { name: /new task/i }).click()

		await page.getByPlaceholder('What are you creating?').fill('E2E Test Object')
		await page.getByRole('button', { name: 'Create' }).click()

		// Should navigate to the object detail page
		await expect(page.getByText('E2E Test Object')).toBeVisible({ timeout: 10000 })
	})

	test('can view an object created via API', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'API Created Bet',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)

		await expect(page.getByText('API Created Bet')).toBeVisible({ timeout: 10000 })
	})

	test('renders the object title as a static heading on the rebuilt detail surface', async ({
		page,
		account,
	}) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Original Title',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Original Title' })).toBeVisible({
			timeout: 10000,
		})

		// The rebuilt surface (bet/object-detail, T1 static shell) renders the
		// title read-only — the legacy edit-in-place textarea is gone. Title
		// editing is out of scope for this surface; nothing else on the page may
		// masquerade as the title editor.
		await expect(page.getByPlaceholder('Untitled')).toHaveCount(0)
	})

	test('can delete an object', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'Object To Delete',
			status: 'new',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByText('Object To Delete')).toBeVisible({ timeout: 10000 })

		// Delete is inside the "More actions" dropdown
		await page.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: 'Delete' }).click()
		await expect(page.getByText('Delete this insight?')).toBeVisible()
		await page.getByRole('button', { name: 'Delete' }).last().click()

		// Should redirect back to workspace
		await expect(page).not.toHaveURL(/objects\//, { timeout: 10000 })
	})

	test('can open create form via the header New menu', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)

		// The objects list toolbar has its own "New" button too — scope to the
		// global header so this exercises the header's New menu specifically.
		await page.locator('header').getByRole('button', { name: /^new$/i }).click()
		await page.getByRole('menuitem', { name: /new insight/i }).click()

		// Seeded with a defaultType, so the picker skips straight to the title input.
		await expect(page.getByPlaceholder('What are you creating?')).toBeVisible()
	})
})
