import { expect, test } from '../fixtures/auth.fixture'

test.describe('Workspace Navigation', () => {
	test('can navigate to workspace pages via sidebar', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		// Should load the workspace (bets dashboard is the default)
		await expect(page).toHaveURL(new RegExp(account.workspaceId), { timeout: 10000 })

		// Navigate to Objects
		await page.getByRole('link', { name: 'Items' }).click()
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/objects`))

		// Navigate to Agents. The v2 shell drops Agents from the nav list — the
		// sidebar footer's activity card is its entry point (sidebar-activity.tsx).
		await page.getByTestId('sidebar-activity').click()
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/agents`))
	})

	test('the bottom bar at 375px lists For you, Chats, Flows, then Items', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await page.goto(`/${account.workspaceId}`)
		const bar = page.getByRole('navigation', { name: 'Primary' })
		await expect(bar).toBeVisible({ timeout: 15_000 })
		const labels = await bar
			.getByRole('link')
			.evaluateAll((links) => links.map((l) => (l.getAttribute('aria-label') ?? '').split(',')[0]))
		// Items only appears when an object-type module is enabled; when it does it is last.
		expect(labels.slice(0, 3)).toEqual(['For you', 'Chats', 'Flows'])
		expect(labels.slice(3)).toEqual(labels.length > 3 ? ['Items'] : [])
	})

	test('More opens the sidebar drawer, and the bar is hidden on a full-screen page at 375px', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await page.goto(`/${account.workspaceId}`)
		const bar = page.getByRole('navigation', { name: 'Primary' })
		await expect(bar).toBeVisible({ timeout: 15_000 })
		await bar.getByRole('button', { name: 'More' }).click()
		await expect(page.getByRole('link', { name: 'Marketplace' })).toBeVisible()
		await page.keyboard.press('Escape')

		await page.goto(`/${account.workspaceId}/chats/new`)
		await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0)
	})

	test('redirects unauthenticated users to login', async ({ browser }) => {
		const context = await browser.newContext()
		const page = await context.newPage()

		await page.goto('/')

		await expect(page).toHaveURL('/login', { timeout: 10000 })
		await context.close()
	})
})
