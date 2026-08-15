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

	test('can update an object title', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Original Title',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByPlaceholder('Untitled')).toBeVisible({ timeout: 10000 })

		// The title textbox is always editable — clear and type new value
		const titleInput = page.getByPlaceholder('Untitled')
		await titleInput.fill('Updated Title')
		await titleInput.press('Tab')

		// Verify the title was updated
		await expect(page.getByPlaceholder('Untitled')).toHaveValue('Updated Title')
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
