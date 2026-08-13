import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Bulk-select coverage for the Objects list (bet T2), which replaced the
// DataTable as the default 'list' view. The list surface has no page-level
// "Select all" header checkbox, no tri-state group checkbox, and touch
// drag-select is explicitly out of scope — rows are leaf checkboxes
// (aria-label "Select row") under tappable collapsing groups, and the range
// mechanism is shift-click. These specs reflect that surface; jsdom/Vitest
// component tests can't exercise real pointer capture, hit-testing, or
// modifier-key clicks, so the runtime assertions live here.

test.describe('Bulk-select — checkbox tap zones (ship gate)', () => {
	// The 44×44 hit zone must keep the row checkbox reachable at every
	// ship-gate viewport, not just the visual target.
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`row checkbox is visible and selectable @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Tap Zone Test Bet',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Tap Zone Test Bet')).toBeVisible({ timeout: 10000 })

			const checkbox = page.getByRole('checkbox', { name: 'Select row' }).first()
			await expect(checkbox).toBeVisible()
			await checkbox.click()

			await expect(page.getByLabel('1 selected')).toBeVisible()
		})
	}
})

test.describe('Bulk-select — grouped list selection', () => {
	// Desktop-mode ship-gate widths (768 portrait, 1024 landscape): grouped by
	// status, groups render collapsed with their row counts, and leaf checkboxes
	// under an expanded group drive the bulk bar.
	for (const viewport of [VIEWPORTS.tabletPortrait, VIEWPORTS.tabletLandscape]) {
		test(`leaf selection under a status group drives the bulk bar @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Group Signal Bet',
				status: 'signal',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Group Qualified Bet A',
				status: 'qualified',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Group Qualified Bet B',
				status: 'qualified',
			})

			await page.goto(`/${account.workspaceId}/objects?groupBy=status`)
			// Groups start collapsed, so leaf titles aren't rendered yet — wait
			// for the group-header label with its row count instead.
			await expect(page.getByText('qualified', { exact: true })).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Group Qualified Bet A')).not.toBeVisible()

			// Expand the qualified group; its two leaves appear under it.
			await page.getByRole('button', { name: /^qualified/ }).click()
			await expect(page.getByText('Group Qualified Bet A')).toBeVisible()

			// Selecting leaves one at a time grows the bulk bar count.
			const leafCheckboxes = page.getByRole('checkbox', { name: 'Select row' })
			await leafCheckboxes.first().click()
			await expect(page.getByLabel('1 selected')).toBeVisible()

			await leafCheckboxes.nth(1).click()
			await expect(page.getByLabel('2 selected')).toBeVisible()

			// Selection is keyed by object id and survives collapsing the group.
			await page.getByRole('button', { name: /^qualified/ }).click()
			await expect(page.getByText('Group Qualified Bet A')).not.toBeVisible()
			await expect(page.getByLabel('2 selected')).toBeVisible()
		})
	}
})

test.describe('Bulk-select — archive action', () => {
	// Running a bulk action (T6) through the real list surface: select two rows,
	// hit Archive, and confirm the action applies to all selected and the bar
	// clears. Archived rows are hidden from the default list, so the titles
	// should drop out after the mutation lands.
	for (const viewport of [VIEWPORTS.tabletPortrait, VIEWPORTS.tabletLandscape]) {
		test(`archive applies to all selected rows @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Archive Bet A',
				status: 'signal',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Archive Bet B',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			await expect(page.getByText('Archive Bet A')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('Archive Bet B')).toBeVisible()

			await page.getByRole('checkbox', { name: 'Select row' }).first().click()
			await page.getByRole('checkbox', { name: 'Select row' }).nth(1).click()
			await expect(page.getByLabel('2 selected')).toBeVisible()

			await page.getByRole('button', { name: 'Archive selected' }).click()

			// Full success clears the selection and the default list hides archived rows.
			await expect(page.getByLabel('2 selected')).not.toBeVisible()
			await expect(page.getByText('Archive Bet A')).not.toBeVisible()
			await expect(page.getByText('Archive Bet B')).not.toBeVisible()
		})
	}
})

test.describe('Bulk-select — shift-click range selection', () => {
	// The list's range mechanism is shift-click (the DataTable era used touch
	// drag-select, out of scope for the T2 list). A plain click anchors the
	// group's range; a subsequent shift-click extends to the swept range.
	test('plain click then shift-click selects the range', async ({ page, account }) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })
		for (let i = 1; i <= 3; i++) {
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Shift Select Bet ${i}`,
				status: 'signal',
			})
		}

		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText('Shift Select Bet')).toBeVisible({ timeout: 10000 })

		// Ordinary click anchors the range on the first row.
		await page.getByRole('checkbox', { name: 'Select row' }).first().click()
		await expect(page.getByLabel('1 selected')).toBeVisible()

		// Shift-click the third row's background. The checkbox and the title
		// Link both stop propagation, so the shift-click must land on the row's
		// own surface (what a real user clicks in the gap between cells).
		await page
			.locator('[data-obj-id]')
			.nth(2)
			.click({ modifiers: ['Shift'] })
		await expect(page.getByLabel('3 selected')).toBeVisible()
	})
})
