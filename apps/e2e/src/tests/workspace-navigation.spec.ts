import { expect, test } from '../fixtures/auth.fixture'

test.describe('Workspace Navigation', () => {
	test('can navigate to workspace pages via sidebar', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		// Should load the workspace (bets dashboard is the default)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10000 })

		// Navigate to Objects
		await page.getByRole('link', { name: 'Objects' }).click()
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/objects`))

		// Navigate to Activity
		await page.getByRole('link', { name: 'Activity' }).click()
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/activity`))

		// Navigate to Agents
		await page.getByRole('link', { name: 'Agents' }).click()
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/agents`))
	})

	test('redirects unauthenticated users to login', async ({ browser }) => {
		const context = await browser.newContext()
		const page = await context.newPage()

		await page.goto('/')

		await expect(page).toHaveURL('/login', { timeout: 10000 })
		await context.close()
	})
})
