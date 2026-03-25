import { expect, test } from '../fixtures/auth.fixture'

test.describe('Objects Filtering', () => {
	test('can filter objects by type', async ({ page, account }) => {
		// Create one of each type via API
		await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'Filter Test Insight',
			status: 'new',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Filter Test Bet',
			status: 'signal',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Filter Test Task',
			status: 'todo',
		})

		await page.goto(`/${account.workspaceId}/objects`)

		// All tab — should see all 3
		await expect(page.getByText('Filter Test Insight')).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('Filter Test Bet')).toBeVisible()
		await expect(page.getByText('Filter Test Task')).toBeVisible()

		// Click Insights tab
		await page.getByRole('button', { name: 'Insights' }).click()
		await expect(page.getByText('Filter Test Insight')).toBeVisible()
		await expect(page.getByText('Filter Test Bet')).not.toBeVisible()
		await expect(page.getByText('Filter Test Task')).not.toBeVisible()

		// Click Bets tab
		await page.getByRole('button', { name: 'Bets' }).click()
		await expect(page.getByText('Filter Test Bet')).toBeVisible()
		await expect(page.getByText('Filter Test Insight')).not.toBeVisible()
		await expect(page.getByText('Filter Test Task')).not.toBeVisible()

		// Click Tasks tab
		await page.getByRole('button', { name: 'Tasks' }).click()
		await expect(page.getByText('Filter Test Task')).toBeVisible()
		await expect(page.getByText('Filter Test Insight')).not.toBeVisible()
		await expect(page.getByText('Filter Test Bet')).not.toBeVisible()

		// Click All tab — back to all 3
		await page.getByRole('button', { name: 'All' }).click()
		await expect(page.getByText('Filter Test Insight')).toBeVisible()
		await expect(page.getByText('Filter Test Bet')).toBeVisible()
		await expect(page.getByText('Filter Test Task')).toBeVisible()
	})

	test('can search objects by title', async ({ page, account }) => {
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Unique Alpha Object',
			status: 'signal',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Unique Beta Object',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects`)

		await expect(page.getByText('Unique Alpha Object')).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('Unique Beta Object')).toBeVisible()

		// Search for "Alpha"
		await page.getByPlaceholder('Search...').fill('Alpha')

		await expect(page.getByText('Unique Alpha Object')).toBeVisible()
		await expect(page.getByText('Unique Beta Object')).not.toBeVisible()

		// Clear search
		await page.getByPlaceholder('Search...').clear()

		await expect(page.getByText('Unique Alpha Object')).toBeVisible()
		await expect(page.getByText('Unique Beta Object')).toBeVisible()
	})
})
