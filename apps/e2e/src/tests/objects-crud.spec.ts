import { randomUUID } from 'node:crypto'
import { expect, test } from '../fixtures/auth.fixture'

test.describe('Objects CRUD', () => {
	test('can create a new bet', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects/${randomUUID()}`)

		// The create form should be open with an empty title field
		await expect(page.getByPlaceholder('Untitled')).toBeVisible()

		// Fill in the title then select the type — auto-create fires when both are set
		await page.getByPlaceholder('Untitled').fill('E2E Test Bet')
		await page.getByRole('button', { name: 'Bets' }).click()

		// Should navigate to the object detail page
		await expect(page.getByText('E2E Test Bet')).toBeVisible({ timeout: 10000 })
	})

	test('can create an insight', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects/${randomUUID()}`)

		await expect(page.getByPlaceholder('Untitled')).toBeVisible()
		await page.getByPlaceholder('Untitled').fill('E2E Test Insight')
		await page.getByRole('button', { name: 'Insights' }).click()

		await expect(page.getByText('E2E Test Insight')).toBeVisible({ timeout: 10000 })
	})

	test('can create a task', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects/${randomUUID()}`)

		await expect(page.getByPlaceholder('Untitled')).toBeVisible()
		await page.getByPlaceholder('Untitled').fill('E2E Test Task')
		await page.getByRole('button', { name: 'Tasks' }).click()

		await expect(page.getByText('E2E Test Task')).toBeVisible({ timeout: 10000 })
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
		await page.getByRole('button', { name: 'Confirm' }).click()

		// Should redirect back to workspace
		await expect(page).not.toHaveURL(/objects\//, { timeout: 10000 })
	})

	test('can open create form via header create button', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)

		// The header + button opens a dropdown; click Object to navigate to the create form
		await page.getByRole('button', { name: 'Create new' }).click()
		await page.getByRole('menuitem', { name: 'Object' }).click()

		await expect(page.getByPlaceholder('Untitled')).toBeVisible()
	})
})
