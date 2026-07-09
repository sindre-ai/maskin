import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

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

test.describe('Objects Metadata Filtering', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`filters by a custom metadata field and persists on reload — ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			// Seed a per-type custom field definition, then two bets with different
			// values for it. Shallow-merges into existing workspace settings.
			await account.api.updateWorkspace(account.workspaceId, {
				settings: { field_definitions: { bet: [{ name: 'region', type: 'text' }] } },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Region EMEA Bet',
				status: 'signal',
				metadata: { region: 'emea' },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Region APAC Bet',
				status: 'signal',
				metadata: { region: 'apac' },
			})

			// Land on the Bets tab — metadata filter rows only show for a single type.
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Region EMEA Bet')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Region APAC Bet')).toBeVisible()

			// Open the Display panel and set the metadata filter. The control must be
			// reachable and interactive at every ship-gate viewport.
			await page.getByRole('button', { name: /display/i }).click()
			const regionFilter = page.getByPlaceholder('Any')
			await expect(regionFilter).toBeVisible()
			await regionFilter.fill('emea')
			await page.keyboard.press('Escape')

			// List narrows to the matching bet.
			await expect(page.getByText('Region EMEA Bet')).toBeVisible()
			await expect(page.getByText('Region APAC Bet')).not.toBeVisible()

			// Filter is encoded in the URL and survives a reload.
			await expect(page).toHaveURL(/metadata\.region=emea/)
			await page.reload()
			await expect(page.getByText('Region EMEA Bet')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Region APAC Bet')).not.toBeVisible()
		})
	}
})
