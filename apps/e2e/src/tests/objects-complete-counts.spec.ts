import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The Objects page shows the server's totals, not a count of whichever rows have
// loaded. Seed more bets than one page holds, with the few `active` ones OLDEST
// so they sit past the first 50 rows under the default newest-first order — the
// shape that used to hide them. The tab count and the Active group must be exact
// the moment the page renders, without scrolling.
const ACTIVE_BETS = 3
const SIGNAL_BETS = 55
const TOTAL_BETS = ACTIVE_BETS + SIGNAL_BETS

test.describe('Objects page shows complete counts', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`tab count and group totals are exact without scrolling @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.updateWorkspace(account.workspaceId, {
				settings: { statuses: { bet: ['signal', 'active'] } },
			})

			for (let i = 0; i < ACTIVE_BETS; i++) {
				await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: `Counts active ${i}`,
					status: 'active',
				})
			}
			for (let i = 0; i < SIGNAL_BETS; i++) {
				await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: `Counts signal ${i}`,
					status: 'signal',
				})
			}

			await page.goto(`/${account.workspaceId}/objects?type=bet&groupBy=status`)

			// The tab carries the real total even though only a page of rows is in hand.
			await expect(
				page.getByRole('button', { name: new RegExp(`Bets.*${TOTAL_BETS}`) }),
			).toBeVisible({ timeout: 15_000 })

			// Each group header carries its own exact total...
			const activeHeader = page
				.getByRole('button', { expanded: true })
				.filter({ hasText: 'active' })
			await expect(activeHeader).toContainText(String(ACTIVE_BETS))
			const signalHeader = page
				.getByRole('button', { expanded: true })
				.filter({ hasText: 'signal' })
			await expect(signalHeader).toContainText(String(SIGNAL_BETS))

			// ...and the oldest rows are there, though they sit past the first page.
			for (let i = 0; i < ACTIVE_BETS; i++) {
				await expect(page.getByText(`Counts active ${i}`)).toBeVisible()
			}

			// The numbers do not move while the list settles.
			await expect(activeHeader).toContainText(String(ACTIVE_BETS))
			await expect(
				page.getByRole('button', { name: new RegExp(`Bets.*${TOTAL_BETS}`) }),
			).toBeVisible()
		})
	}

	test('a status filter shows every matching row, not just those on the first page', async ({
		page,
		account,
	}) => {
		await account.api.updateWorkspace(account.workspaceId, {
			settings: { statuses: { bet: ['signal', 'active'] } },
		})
		for (let i = 0; i < ACTIVE_BETS; i++) {
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Filtered active ${i}`,
				status: 'active',
			})
		}
		for (let i = 0; i < SIGNAL_BETS; i++) {
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Filtered signal ${i}`,
				status: 'signal',
			})
		}

		await page.goto(`/${account.workspaceId}/objects?type=bet&status=active`)

		for (let i = 0; i < ACTIVE_BETS; i++) {
			await expect(page.getByText(`Filtered active ${i}`)).toBeVisible({ timeout: 15_000 })
		}
		await expect(page.getByText('Filtered signal 0')).not.toBeVisible()
	})
})
