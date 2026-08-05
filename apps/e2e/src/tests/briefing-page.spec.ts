import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Briefing page — /$workspaceId/briefing', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders the ## Commitments section for seeded commitments at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			// Seed one commitment per health state so the priority ordering is exercised.
			await account.api.createObject(account.workspaceId, {
				type: 'commitment',
				title: 'Onboarding NPS floor',
				status: 'breached',
				metadata: { floor: '≥40 NPS', cadence: 'monthly' },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'commitment',
				title: 'Customer bugs fixed <1 day',
				status: 'at-risk',
				metadata: { floor: '<1 day median TTR', cadence: 'weekly' },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'commitment',
				title: 'Weekly release cadence',
				status: 'holding',
				metadata: { floor: 'ship at least 1/week', cadence: 'weekly' },
			})

			await page.goto(`/${account.workspaceId}/briefing`)

			// H1 renders regardless of state.
			await expect(page.getByRole('heading', { name: 'Briefing', level: 1 })).toBeVisible({
				timeout: 10000,
			})

			// The ## Commitments markdown heading renders as an <h2> after the composer runs.
			await expect(page.getByRole('heading', { name: 'Commitments', level: 2 })).toBeVisible({
				timeout: 10000,
			})

			await expect(page.getByText('Onboarding NPS floor')).toBeVisible()
			await expect(page.getByText('Customer bugs fixed <1 day')).toBeVisible()
			await expect(page.getByText('Weekly release cadence')).toBeVisible()
		})
	}

	test('stays silent (no ## Commitments heading) when no commitments are seeded', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/briefing`)

		await expect(page.getByRole('heading', { name: 'Briefing', level: 1 })).toBeVisible({
			timeout: 10000,
		})
		await expect(page.getByRole('heading', { name: 'Commitments', level: 2 })).toHaveCount(0)
	})
})
