import { expect, test } from '@playwright/test'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Security page', () => {
	test('renders without a login redirect', async ({ page }) => {
		await page.goto('/security')

		await expect(page).toHaveURL('/security')
		await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()
	})

	test('names Magnus as compliance owner of record', async ({ page }) => {
		await page.goto('/security')

		await expect(page.getByRole('heading', { level: 2, name: 'Compliance owner' })).toBeVisible()
		await expect(page.getByText(/Magnus is our compliance owner of record/)).toBeVisible()
	})

	test('hides the observation-underway line by default', async ({ page }) => {
		await page.goto('/security')

		await expect(page.getByText(/observation period underway/i)).toHaveCount(0)
		await expect(
			page.getByText(/observation status on this page once the observation period begins/i),
		).toBeVisible()
	})

	test.describe('responsive — key copy visible at ship-gate viewports', () => {
		for (const vp of SHIP_GATE_VIEWPORTS) {
			test(`renders headings and compliance owner at ${vp.label}`, async ({ page }) => {
				await page.setViewportSize({ width: vp.width, height: vp.height })
				await page.goto('/security')

				await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible()
				await expect(
					page.getByRole('heading', { level: 2, name: 'Compliance owner' }),
				).toBeVisible()
				await expect(page.getByRole('heading', { level: 2, name: 'SOC 2 Type II' })).toBeVisible()
				await expect(page.getByText(/Magnus is our compliance owner of record/)).toBeVisible()
			})
		}
	})
})
