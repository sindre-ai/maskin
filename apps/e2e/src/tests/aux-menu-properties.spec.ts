import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// The ⋯ menu on a bet detail page grows a Properties group at narrow-desktop
// (1000×768) and on mobile (375×812) — Status + Driver graduate off the hero
// into the menu so the sticky nav can compact. Wide desktop (1440×900) keeps
// the menu unchanged.
test.describe('AuxiliaryActionMenu — Properties group on bet detail', () => {
	const NARROW_DESKTOP = { width: 1000, height: 768, label: 'narrow desktop (1000×768)' }

	for (const vp of [VIEWPORTS.mobile, NARROW_DESKTOP]) {
		test(`Properties group leads the ⋯ menu @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Aux properties probe ${vp.width}`,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByPlaceholder('Untitled')).toHaveValue(bet.title ?? '', {
				timeout: 10_000,
			})

			await page.getByRole('button', { name: /more actions/i }).click()

			// Status + Driver rows appear inside the menu / sheet at these widths.
			await expect(page.getByText(/^Status$/)).toBeVisible()
			await expect(page.getByText(/^Driver$/)).toBeVisible()
		})
	}

	test('Wide desktop leaves the ⋯ menu unchanged (no Properties group)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 })

		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Aux properties probe wide',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByPlaceholder('Untitled')).toHaveValue(bet.title ?? '', {
			timeout: 10_000,
		})

		await page.getByRole('button', { name: /more actions/i }).click()
		// The Properties group is gated behind the touch/mobile viewport hooks —
		// on wide desktop only the existing action rows show.
		await expect(page.getByText(/^Properties$/i)).toHaveCount(0)
	})
})
