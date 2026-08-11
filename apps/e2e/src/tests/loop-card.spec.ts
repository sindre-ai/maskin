import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The rebuilt object-detail shell (bet/object-detail, T1) does not yet
// render the commitment card — commitment metadata surfaces as key/value
// rows in the body (metadata-badges formatValue path) and the raw status in
// the identity-row status control. The card itself is pinned as an absence
// contract until a later task wires it into the shell.

test.describe('Commitment object on the rebuilt detail surface', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`holding commitment renders title, status, floor, cadence rows at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const commitment = await account.api.createObject(account.workspaceId, {
				type: 'commitment',
				title: 'Customer bugs fixed <1 day',
				status: 'holding',
				metadata: {
					floor: '<1 day median',
					cadence: 'weekly',
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

			// Metadata renders as body key/value rows (floor, cadence). The
			// values use exact matching — 'weekly' is a substring of the
			// breached-test title, so non-exact getByText would strict-collide.
			await expect(page.getByText('<1 day median', { exact: true })).toBeVisible()
			await expect(page.getByText('weekly', { exact: true })).toBeVisible()

			// The commitment card is not part of the T1 shell yet.
			await expect(page.getByTestId('commitment-card')).toHaveCount(0)
		})
	}

	test('breached commitment renders its floor/cadence rows at 1024×768', async ({
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
		await expect(page.getByText('1 ship / week', { exact: true })).toBeVisible()
		await expect(page.getByText('weekly', { exact: true })).toBeVisible()

		// The commitment card is not part of the T1 shell yet.
		await expect(page.getByTestId('commitment-card')).toHaveCount(0)
	})
})
