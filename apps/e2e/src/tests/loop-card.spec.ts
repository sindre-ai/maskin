import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The rebuilt object-detail shell renders the commitment card (a
// `data-testid="commitment-card"` section) above the body, with floor and
// cadence as definition rows inside it. The title is an editable textarea,
// not a heading, and the raw status lives in the identity-row status control.

test.describe('Commitment object on the rebuilt detail surface', () => {
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
			await expect(
				page.getByRole('heading', { level: 1, name: 'Customer bugs fixed <1 day' }),
			).toBeVisible({ timeout: 10000 })

			// Raw status in the identity-row status control.
			const statusControl = page
				.getByRole('combobox')
				.filter({ hasNotText: /driver/i })
				.first()
			await expect(statusControl).toHaveText('holding')

			// Floor and cadence render as definition rows inside the card. The
			// values use exact matching — 'weekly' is a substring of the
			// breached-test title, so non-exact getByText would strict-collide.
			const card = page.getByTestId('commitment-card')
			await expect(card).toBeVisible()
			await expect(card.getByText('<1 day median', { exact: true })).toBeVisible()
			await expect(card.getByText('weekly', { exact: true })).toBeVisible()

			// Source bet renders as a link inside the card and navigates.
			const sourceLink = card.getByRole('link', {
				name: /Customer bugs fixed under 1 day/i,
			})
			await expect(sourceLink).toBeVisible()
			await sourceLink.click()
			await expect(
				page.getByRole('heading', {
					level: 1,
					name: 'Customer bugs fixed under 1 day (source)',
				}),
			).toBeVisible({ timeout: 10000 })
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
		await expect(page.getByRole('heading', { level: 1, name: 'Weekly ship cadence' })).toBeVisible({
			timeout: 10000,
		})

		const statusControl = page
			.getByRole('combobox')
			.filter({ hasNotText: /driver/i })
			.first()
		await expect(statusControl).toHaveText('breached')

		const card = page.getByTestId('commitment-card')
		await expect(card).toBeVisible()
		await expect(card.getByText('1 ship / week', { exact: true })).toBeVisible()
		await expect(card.getByText('weekly', { exact: true })).toBeVisible()
		await expect(card.getByText('Last breach')).toBeVisible()
		await expect(card.locator('time[datetime="2026-07-08T12:00:00.000Z"]')).toBeVisible()
	})
})
