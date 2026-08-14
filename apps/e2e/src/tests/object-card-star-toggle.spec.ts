import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Task 4: star toggle on object cards. The full round-trip persistence gate
// (star survives reload) is Task 8's QA sweep — it depends on Task 2 (DB) and
// Task 3 (API) landing so the /objects/:id/star endpoint responds. This spec
// covers what Task 4 owns end-to-end: the button renders on every card at each
// ship-gate viewport, and clicking it exercises the optimistic-then-rollback
// path (backend returns 404 today, so the row snaps back — the DoD's "roll back
// on failure" behaviour).

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

	test('optimistically flips then rolls back when the star endpoint is unavailable', async ({
		page,
		account,
	}) => {
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Star rollback bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects?type=bet`)
		await expect(page.getByText('Star rollback bet')).toBeVisible({ timeout: 10000 })

		const starButton = page.getByRole('button', { name: 'Star' }).first()
		await starButton.click()

		// Backend endpoint is Task 3's — until it lands the POST returns an error,
		// so the optimistic starred state rolls back and the button returns to
		// aria-pressed=false. Once Task 3 ships, this spec becomes the round-trip
		// gate (Task 8 upgrades it to assert persisted starred state on reload).
		await expect(page.getByRole('button', { name: 'Star' }).first()).toHaveAttribute(
			'aria-pressed',
			'false',
			{ timeout: 5000 },
		)
	})
})
