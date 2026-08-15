import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Commitment card — object detail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`holding commitment renders title, chip, floor, cadence, source-bet link at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const sourceBet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Customer bugs fixed under 1 day (source)',
				status: 'succeeded',
			})

			const commitment = await account.api.createObject(account.workspaceId, {
				type: 'commitment',
				title: 'Customer bugs fixed <1 day',
				status: 'holding',
				metadata: {
					floor: '<1 day median',
					cadence: 'weekly',
					source_bet_id: sourceBet.id,
				},
			})

			await page.goto(`/${account.workspaceId}/objects/${commitment.id}`)
			await expect(page.locator('textarea').first()).toHaveValue('Customer bugs fixed <1 day', {
				timeout: 10000,
			})

			const card = page.getByTestId('commitment-card')
			await expect(card).toBeVisible()
			await expect(card.getByText('holding')).toBeVisible()
			await expect(card.getByText('<1 day median')).toBeVisible()
			await expect(card.getByText('weekly')).toBeVisible()

			const sourceLink = card.getByRole('link', {
				name: /Customer bugs fixed under 1 day/i,
			})
			await expect(sourceLink).toBeVisible()
			await sourceLink.click()
			await expect(page.locator('textarea').first()).toHaveValue(
				'Customer bugs fixed under 1 day (source)',
				{ timeout: 10000 },
			)
		})
	}

	test('breached commitment renders red chip and last_breach_at at 1024×768', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const commitment = await account.api.createObject(account.workspaceId, {
			type: 'commitment',
			title: 'Weekly ship cadence',
			status: 'breached',
			metadata: {
				floor: '1 ship / week',
				cadence: 'weekly',
				last_breach_at: '2026-07-08T12:00:00.000Z',
			},
		})

		await page.goto(`/${account.workspaceId}/objects/${commitment.id}`)
		await expect(page.locator('textarea').first()).toHaveValue('Weekly ship cadence', {
			timeout: 10000,
		})

		const card = page.getByTestId('commitment-card')
		await expect(card).toBeVisible()
		await expect(card.getByText('breached')).toBeVisible()
		await expect(card.getByText('Last breach')).toBeVisible()
		await expect(card.locator('time[datetime="2026-07-08T12:00:00.000Z"]')).toBeVisible()
	})
})
