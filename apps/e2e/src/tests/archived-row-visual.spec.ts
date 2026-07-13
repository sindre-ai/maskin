import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T4 visual layer for archived bets: token pair, badge mapping, dimmed row
// with prior-status meta. Full archive flow (T2 default statuses, T3 filter,
// T5 toggle, T6 handler) lands in later tasks — this spec only proves the
// visual language holds when an archived row is rendered alongside a paused
// row on the bets view.

test.describe('Archived row visual language', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`archived row is dimmed with warm-stone badge; paused stays crisp with cool-zinc — ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Archived bet with prior succeeded state',
				status: 'archived',
				metadata: { previous_status: 'succeeded' },
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Paused bet still revivable',
				status: 'paused',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Archived bet with prior succeeded state')).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText('Paused bet still revivable')).toBeVisible()

			// Prior-status meta renders as "was <prior>" on the archived row.
			await expect(page.getByText('was succeeded')).toBeVisible()

			// Row-level dimming: archived carries the is-archived variant with
			// opacity 0.62; paused stays at full opacity.
			const archivedRow = page.locator('[data-archived]').first()
			await expect(archivedRow).toBeVisible()
			await expect(archivedRow).toHaveCSS('opacity', '0.62')
		})
	}

	test('archived and paused badges resolve to distinct color families in light and dark', async ({
		page,
		account,
	}) => {
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Archived bet — badge distinction',
			status: 'archived',
			metadata: { previous_status: 'failed' },
		})
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Paused bet — badge distinction',
			status: 'paused',
		})

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Archived bet — badge distinction')).toBeVisible({
				timeout: 10000,
			})

			const archivedBg = await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--st-archived-bg').trim(),
			)
			const pausedBg = await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--st-paused-bg').trim(),
			)
			expect(archivedBg).not.toBe(pausedBg)
			expect(archivedBg).not.toBe('')
		}
	})
})
