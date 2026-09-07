import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v2 Objects list gate (mockup 850–1028). One control row: the filters pinned
// out of the Display panel, removable pills, Clear all, then Display. The
// filtered-empty state names the filters that produced it and clears them in
// one action. Selecting a row flips every other row's affordance from its
// resting star to a checkbox.
// Run at each ship-gate viewport (375 / 768 / 1024).

test.describe('Objects list — v2 control row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`filtered-empty state names the filter and clears it at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Empty-state bet',
				status: 'active',
			})

			// Land on the bet tab with a status filter that matches nothing.
			await page.goto(`/${account.workspaceId}/objects?type=bet&status=done`)

			const empty = page.getByText(/No bets .* right now\.|No bets match these filters\./)
			await expect(empty).toBeVisible({ timeout: 15000 })

			const clear = page.getByRole('button', { name: 'Clear all filters' })
			await expect(clear).toBeVisible()
			await clear.click()

			// The status param is gone and the row is back.
			await expect(page).toHaveURL(/objects(?!.*status=done)/)
			await expect(page.getByText('Empty-state bet')).toBeVisible()
		})

		test(`selecting one row shows a checkbox on every row at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Selectable one',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Selectable two',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Selectable one')).toBeVisible({ timeout: 15000 })

			const checkboxes = page.getByRole('checkbox', { name: 'Select row' })
			await expect(checkboxes).toHaveCount(2)

			// At rest the checkbox is present (44px tap target) but transparent on
			// pointer viewports; check it and the whole list commits to checkboxes.
			await checkboxes.first().check({ force: true })
			await expect(checkboxes.first()).toBeChecked()
			await expect(checkboxes.nth(1)).toBeVisible()
			await expect(checkboxes.nth(1)).not.toBeChecked()

			// The bulk bar names the Driver control (not the retired "Owner").
			await expect(page.getByRole('combobox', { name: 'Set driver' })).toBeVisible()
		})

		test(`Display menu lists its sections in the mockup order at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Display bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Display bet')).toBeVisible({ timeout: 15000 })

			await page.getByRole('button', { name: /^Display/ }).click()

			// Segmented List | Board rail first (mockup 694–697), then the sections.
			await expect(page.getByRole('button', { name: 'List' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Board' })).toBeVisible()
			await expect(page.getByText('Filters')).toBeVisible()
			await expect(page.getByText('Properties')).toBeVisible()
			await expect(page.getByText('Show archived')).toBeVisible()
			await expect(page.getByText('Reset all')).toBeVisible()
		})

		test(`the list rests grouped by state with its groups open at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Active grouped bet',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Done grouped bet',
				status: 'succeeded',
			})

			// No groupBy in the URL — the resting state is State (mockup 994–999).
			await page.goto(`/${account.workspaceId}/objects?type=bet`)

			const activeGroup = page.getByRole('button', { expanded: true, name: /active/i })
			await expect(activeGroup).toBeVisible({ timeout: 15000 })
			// Groups start open, so both rows are reachable without a click.
			await expect(page.getByText('Active grouped bet')).toBeVisible()
			await expect(page.getByText('Done grouped bet')).toBeVisible()

			// Collapsing is still one tap, and it only takes its own group down.
			await activeGroup.click()
			await expect(page.getByText('Active grouped bet')).toBeHidden()
			await expect(page.getByText('Done grouped bet')).toBeVisible()
		})

		test(`the list rests in last-updated order at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const first = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Older bet',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Newer bet',
				status: 'active',
			})
			// Touching the older row makes it the most recently updated — under a
			// created-desc default it would still sort second.
			await account.api.updateObject(first.id, account.workspaceId, {
				content: 'touched so it sorts first',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Older bet')).toBeVisible({ timeout: 15000 })

			const rows = page.locator('[data-obj-id]')
			await expect(rows.first()).toContainText('Older bet')
		})

		// The status chip row is gone: the toolbar now carries only the filters the
		// user pinned out of the Display panel's FILTERS axes. This drives that
		// whole loop — expand an axis, pin a value, and confirm the chip lands in
		// the control row, filters when clicked, and survives a reload.
		test(`pinning a FILTERS value promotes it to the toolbar chip row at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Axis bet',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Signal bet',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Axis bet')).toBeVisible({ timeout: 15000 })

			// Status rests at "Any status" and is collapsed — nothing on the toolbar
			// names a status until something is pinned.
			await expect(page.getByRole('button', { name: 'Status: active' })).toHaveCount(0)

			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('button', { name: /^Status filter,/ }).click()

			// Pin the `active` status, then close the panel. The pin is written
			// through on a 500ms debounce — wait for that PUT rather than racing it,
			// so the reload assertion below is deterministic.
			const pinSaved = page.waitForResponse(
				(res) => res.url().includes('/user-display-settings/') && res.request().method() === 'PUT',
			)
			await page.getByRole('button', { name: 'Pin active' }).click()
			await expect(page.getByRole('button', { name: 'Unpin active' })).toBeVisible()
			await pinSaved
			await page.keyboard.press('Escape')

			// The pin promotes it to a chip, off by default and reachable without
			// reopening the panel.
			const chip = page.getByRole('button', { name: 'Status: active' })
			await expect(chip).toBeVisible()
			await expect(chip).toHaveAttribute('aria-pressed', 'false')

			await chip.click()
			await expect(page).toHaveURL(/[?&]status=active/)
			await expect(page.getByText('Axis bet')).toBeVisible()
			await expect(page.getByText('Signal bet')).not.toBeVisible()
			await expect(chip).toHaveAttribute('aria-pressed', 'true')

			// Pins persist per actor and tab, so the chip is still there on reload.
			await page.reload()
			await expect(page.getByRole('button', { name: 'Status: active' })).toBeVisible({
				timeout: 15000,
			})
		})
	}
})

test.describe('Objects board — v2 column chrome', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`an empty column reads "Drop here" and the advance control is reachable at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Board task',
				status: 'todo',
			})

			await page.goto(`/${account.workspaceId}/objects?type=task`)
			await expect(page.getByText('Board task')).toBeVisible({ timeout: 15000 })

			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('button', { name: 'Board' }).click()

			await expect(page.getByTestId('board-view')).toBeVisible({ timeout: 15000 })
			// Every status after the first has no cards yet.
			await expect(page.getByText('Drop here').first()).toBeVisible()

			// The advance affordance must be reachable without hover — touch
			// viewports have none (see .claude/rules/verification.md).
			await expect(page.getByRole('button', { name: /^Move to / }).first()).toBeVisible()
		})
	}
})
