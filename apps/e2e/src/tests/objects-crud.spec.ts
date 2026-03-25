import { expect, test } from '../fixtures/auth.fixture'

test.describe('Objects CRUD', () => {
	test('can create a new bet', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects?create=true`)

		// The create form should be open
		await expect(page.getByPlaceholder("What's this about?")).toBeVisible()

		// Type defaults to 'bet', so just fill in the title
		await page.getByPlaceholder("What's this about?").fill('E2E Test Bet')
		await page.getByPlaceholder('Describe it...').fill('This is a test bet')
		await page.getByRole('button', { name: 'Create', exact: true }).click()

		// Should navigate to the object detail page
		await expect(page.getByText('E2E Test Bet')).toBeVisible({ timeout: 10000 })
	})

	test('can create an insight', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects?create=true`)

		await page.getByRole('button', { name: 'insight', exact: true }).click()
		await page.getByPlaceholder("What's this about?").fill('E2E Test Insight')
		await page.getByRole('button', { name: 'Create', exact: true }).click()

		await expect(page.getByText('E2E Test Insight')).toBeVisible({ timeout: 10000 })
	})

	test('can create a task', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects?create=true`)

		await page.getByRole('button', { name: 'task', exact: true }).click()
		await page.getByPlaceholder("What's this about?").fill('E2E Test Task')
		await page.getByRole('button', { name: 'Create', exact: true }).click()

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
		await expect(page.getByText('Original Title')).toBeVisible({ timeout: 10000 })

		// Click the title to start editing
		await page.getByText('Original Title').click()

		// The title should now be an input — clear and type new value
		const titleInput = page.locator('input[type="text"]').first()
		await titleInput.fill('Updated Title')
		await titleInput.press('Enter')

		// Verify the title was updated
		await expect(page.getByText('Updated Title')).toBeVisible()
	})

	test('can delete an object', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'Object To Delete',
			status: 'new',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByText('Object To Delete')).toBeVisible({ timeout: 10000 })

		// Click Delete, then Confirm
		await page.getByRole('button', { name: 'Delete', exact: true }).click()
		await expect(page.getByText('Delete this insight?')).toBeVisible()
		await page.getByRole('button', { name: 'Confirm' }).click()

		// Should redirect back to workspace
		await expect(page).not.toHaveURL(/objects\//, { timeout: 10000 })
	})

	test('can open create form via + Create button', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)

		await page.getByRole('button', { name: '+ Create' }).click()

		await expect(page.getByPlaceholder("What's this about?")).toBeVisible()
	})
})
