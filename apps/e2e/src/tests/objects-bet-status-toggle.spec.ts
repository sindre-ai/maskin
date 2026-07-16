import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression cover for a customer report that the display menu on the Objects
// page had no show/hide toggle for the bet status (stalled/idle) indicator —
// the pill next to a bet's title on the row. Bet status renders inside the
// Title cell (not as its own column), so the toggle is a synthetic entry in
// the same Properties section as the real column pills.
test.describe('Objects display panel — bet status toggle', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`toggling "Bet status" hides the row indicator on the Objects page @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// A bet + open human-decision task drives the row to "waiting on human",
			// which renders as "waiting" on the row (the chip variant on the detail
			// page reads "waiting on human"). Any non-idle state works — we just
			// need something visible on the row to toggle off.
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Toggle probe bet ${vp.width}`,
				status: 'active',
			})
			const decision = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Approve rollout',
				status: 'todo',
				metadata: { human_decision: true },
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: bet.id,
				target_type: 'task',
				target_id: decision.id,
				type: 'breaks_into',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText(`Toggle probe bet ${vp.width}`)).toBeVisible({
				timeout: 10_000,
			})

			// Row indicator starts visible.
			await expect(page.getByLabel('Status: waiting').first()).toBeVisible()

			// Toggle it off from the Display panel — "Bet status" is a Properties pill.
			await page.getByRole('button', { name: /^Display/ }).click()
			const pill = page.getByRole('dialog').getByRole('button', { name: /Bet status/i })
			await expect(pill).toBeVisible()
			await pill.click()
			await page.keyboard.press('Escape')

			// Indicator is now gone from the row.
			await expect(page.getByLabel('Status: waiting')).toHaveCount(0)

			// Toggle back on — indicator returns.
			await page.getByRole('button', { name: /^Display/ }).click()
			await page
				.getByRole('dialog')
				.getByRole('button', { name: /Bet status/i })
				.click()
			await page.keyboard.press('Escape')
			await expect(page.getByLabel('Status: waiting').first()).toBeVisible()
		})
	}

	test('does not surface the toggle on tabs where bets never appear (Tasks)', async ({
		page,
		account,
	}) => {
		await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Standalone task',
			status: 'todo',
		})

		await page.goto(`/${account.workspaceId}/objects?type=task`)
		await expect(page.getByText('Standalone task')).toBeVisible({ timeout: 10_000 })

		await page.getByRole('button', { name: /^Display/ }).click()
		// Properties section is present but "Bet status" is not one of the pills.
		await expect(page.getByRole('dialog').getByRole('button', { name: /Bet status/i })).toHaveCount(
			0,
		)
	})
})
