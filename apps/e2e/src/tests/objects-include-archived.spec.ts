import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// T5: the DisplayPanel gains a "Show" section with an "Include archived" toggle
// on the bets tab. Default state hides archived; flipping the toggle reveals
// archived rows and sets `?includeArchived=1` so the state is deep-linkable
// and survives reload. The URL param is the whole persistence layer — there
// is no localStorage fallback.
test.describe('Objects — Include archived toggle', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`hides archived by default and reveals them via the DisplayPanel toggle @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Seed one active bet and one archived bet in the same workspace.
			// The active row must be visible in every state; the archived row
			// only when the toggle is on or the URL carries the flag.
			const activeTitle = `Live bet ${Date.now()}`
			const archivedTitle = `Old archived bet ${Date.now()}`
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: activeTitle,
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: archivedTitle,
				status: 'archived',
			})

			// Default state: bet tab active, no toggle flipped.
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText(activeTitle)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText(archivedTitle)).toHaveCount(0)

			// Open the DisplayPanel and flip the "Include archived" switch.
			await page.getByRole('button', { name: /^Display/ }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Show')).toBeVisible()
			const toggle = dialog.getByRole('switch', { name: /include archived/i })
			await expect(toggle).toBeVisible()
			await expect(toggle).toHaveAttribute('data-state', 'unchecked')
			await toggle.click()
			await expect(toggle).toHaveAttribute('data-state', 'checked')

			// Close the popover so the row-level assertions aren't shadowed by
			// the modal on mobile.
			await page.keyboard.press('Escape')

			// URL is now the source of truth for the flag.
			await expect(page).toHaveURL(/includeArchived=1/)

			// Archived row now renders alongside the active one.
			await expect(page.getByText(archivedTitle)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText(activeTitle)).toBeVisible()

			// Reload keeps the toggle on and the archived row visible.
			await page.reload()
			await expect(page.getByText(archivedTitle)).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText(activeTitle)).toBeVisible()
			await expect(page).toHaveURL(/includeArchived=1/)
		})
	}

	// Follow-up to T5: on desktop the chip strip surfaces `Include: archived ✕`
	// so users can dismiss the flag without opening the DisplayPanel. Exercised
	// at 1024 (iPad landscape — the smallest ship-gate viewport that still
	// renders the desktop chip row) so a regression at this breakpoint fails
	// loudly. Higher breakpoints share the same render path.
	test(`removes the includeArchived flag when the chip's ✕ is clicked @ ${VIEWPORTS.tabletLandscape.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})

		const activeTitle = `Chip strip active ${Date.now()}`
		const archivedTitle = `Chip strip archived ${Date.now()}`
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: activeTitle,
			status: 'active',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: archivedTitle,
			status: 'archived',
		})

		// Deep-link straight into the toggle-on state so we're testing the chip,
		// not the toggle plumbing (which the loop above already covers).
		await page.goto(`/${account.workspaceId}/objects?type=bet&includeArchived=1`)
		await expect(page.getByText(archivedTitle)).toBeVisible({ timeout: 10_000 })

		// The chip is rendered inline in the toolbar chip strip. Match on the
		// label + value pair; the remove button carries the shared "Remove
		// Include filter" aria-label from FilterChip.
		const chip = page.getByText('Include:').locator('..')
		await expect(chip).toBeVisible()
		await expect(chip).toContainText('archived')

		await page.getByRole('button', { name: /Remove Include filter/i }).click()

		// URL loses the flag, archived row disappears, active row stays.
		await expect(page).not.toHaveURL(/includeArchived=1/)
		await expect(page.getByText(archivedTitle)).toHaveCount(0)
		await expect(page.getByText(activeTitle)).toBeVisible()
	})
})
