import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v2 Objects list gate (mockup 850–1028). One control row: the FILTER BY axis
// chips, removable pills, Clear all, then Display. The filtered-empty state
// names the filters that produced it and clears them in one action. Selecting
// a row flips every other row's affordance from a type dot to a checkbox.
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

			// Segmented List | Board rail first (mockup 932–937), then the sections.
			await expect(page.getByRole('button', { name: 'List' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Board' })).toBeVisible()
			await expect(page.getByText('Filter by')).toBeVisible()
			await expect(page.getByText('Show in list')).toBeVisible()
			await expect(page.getByText('Show archived')).toBeVisible()
			await expect(page.getByText('Reset to default')).toBeVisible()
		})

		test(`switching the FILTER BY axis re-drives the chip row at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Axis bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Axis bet')).toBeVisible({ timeout: 15000 })

			// Status is the resting axis, so its values drive the chip row.
			await expect(page.getByRole('button', { name: /^active/ })).toBeVisible()

			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('button', { name: 'Attention' }).click()
			await page.keyboard.press('Escape')

			await expect(page).toHaveURL(/filterBy=attention/)
			await expect(page.getByRole('button', { name: /^Waiting on you/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /^Agent working/ })).toBeVisible()
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
