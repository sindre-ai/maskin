import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Star toggle on object cards — combined Task 4 (UI) + Task 3 (API) gate.
// Task 4 established the button renders and the optimistic-update path works.
// Task 3 landed the API endpoint, so clicking now persists the star rather than
// rolling back. Task 8 extends this to assert persistence across a page reload.

test.describe('Object card star toggle', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`star button renders on every object card — ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Star target bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Star target bet')).toBeVisible({ timeout: 10000 })

			const starButton = page.getByRole('button', { name: 'Star' }).first()
			await expect(starButton).toBeVisible()
			await expect(starButton).toHaveAttribute('aria-pressed', 'false')
		})
	}

	test('clicking the star button persists the starred state', async ({ page, account }) => {
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Star persist bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects?type=bet`)
		await expect(page.getByText('Star persist bet')).toBeVisible({ timeout: 10000 })

		const starButton = page.getByRole('button', { name: 'Star' }).first()
		await starButton.click()

		// Task 3's endpoint is live — POST /api/objects/:id/star returns 200 { starred: true }.
		// The optimistic update flips to aria-pressed=true and the settled mutation
		// confirms it. Task 8 adds the reload assertion (star survives a full page refresh).
		await expect(page.getByRole('button', { name: 'Unstar' }).first()).toHaveAttribute(
			'aria-pressed',
			'true',
			{ timeout: 5000 },
		)
	})
})
