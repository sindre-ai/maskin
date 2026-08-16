import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 (shared filter model) — the bet's "First test": one filter model powers
// both view modes, so a filter set in the List must apply in the Board.
// Parity is structural (toBoardParams spreads toListParams on the same model
// instance), but this spec proves the parity surface end-to-end against the
// real stack at every ship-gate viewport: set a metadata filter in the List,
// switch to Board, and assert only the matching card renders.
test.describe('Objects filter parity (List -> Board)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`metadata filter set in List applies in Board @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Board is only reachable for a single type with at least one
			// configured status, so make it deterministic: set bet statuses.
			await account.api.updateWorkspace(account.workspaceId, {
				settings: {
					statuses: { bet: ['signal', 'active'] },
					field_definitions: { bet: [{ name: 'region', type: 'text' }] },
				},
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Parity EMEA Bet',
				status: 'signal',
				metadata: { region: 'emea' },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Parity APAC Bet',
				status: 'active',
				metadata: { region: 'apac' },
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)

			// Wait for the List to settle — both bets visible.
			await expect(page.getByText('Parity EMEA Bet')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('Parity APAC Bet')).toBeVisible()

			// Set the metadata filter in the List view via the Display panel.
			// The control must be reachable and interactive at every viewport.
			await page.getByRole('button', { name: /display/i }).click()
			const regionFilter = page.getByPlaceholder('Any')
			await expect(regionFilter).toBeVisible()
			await regionFilter.fill('emea')
			await page.keyboard.press('Escape')

			// List narrows to the matching bet, and the filter is in the URL.
			await expect(page.getByText('Parity EMEA Bet')).toBeVisible()
			await expect(page.getByText('Parity APAC Bet')).not.toBeVisible()
			await expect(page).toHaveURL(/metadata\.region=emea/)

			// Switch to Board — the Board pill only renders for supported types.
			await page.getByRole('button', { name: /display/i }).click()
			await page.getByRole('button', { name: 'Board', exact: true }).click()

			// The board query carries the same filter (parity): only the EMEA
			// card renders, the APAC card never appears. The URL still encodes
			// the filter so the parity surface survives navigation/reload.
			await expect(page.getByTestId('board-view')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('Parity EMEA Bet')).toBeVisible()
			await expect(page.getByText('Parity APAC Bet')).not.toBeVisible()
			await expect(page).toHaveURL(/metadata\.region=emea/)
		})
	}
})
