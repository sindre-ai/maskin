import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loops list page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`empty workspace renders the empty state at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByRole('heading', { name: 'Loops' })).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('No loops running here yet')).toBeVisible()
		})

		test(`renders a loop row with derived stats at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback',
				status: 'running',
				content: 'Every customer who gives feedback hears back within 30 days',
			})

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText('Customer feedback')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Running')).toBeVisible()
			await expect(page.getByText(/in progress/i)).toBeVisible()
		})
	}

	test('sidebar Loops entry navigates to /loops', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('link', { name: 'Loops' }).click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops`), { timeout: 10000 })
		await expect(page.getByRole('heading', { name: 'Loops' })).toBeVisible()
	})

	test('triggers page continues to render for workspaces with only triggers', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.goto(`/${account.workspaceId}/triggers`)

		await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible({ timeout: 10000 })
		// The empty state on Triggers is the pre-existing copy — asserting it
		// verifies the extraction of TriggerRow into a shared component did not
		// regress the Triggers surface.
		await expect(page.getByText('No triggers yet')).toBeVisible()
	})
})
