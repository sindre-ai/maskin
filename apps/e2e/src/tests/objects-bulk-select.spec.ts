import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Ship-gate coverage for the iOS bulk-select ergonomics bet (T1, T3, T6), which
// previously shipped with zero Playwright coverage — jsdom/Vitest component
// tests can't exercise real pointer capture, elementFromPoint hit-testing, or
// RAF-driven autoscroll timing.

test.describe('Bulk-select — checkbox tap zones (ship gate)', () => {
	// T1: the 44×44 hit zone must keep the row checkbox reachable at every
	// ship-gate viewport, not just the visual 16×16 target.
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

test.describe('Bulk-select — grouped selection', () => {
	// Desktop table layout (>=768px) renders the page-level "Select all" header
	// checkbox and the group-header rows — assert at both desktop-mode
	// ship-gate widths (768 portrait, 1024 landscape).
	for (const viewport of [VIEWPORTS.tabletPortrait, VIEWPORTS.tabletLandscape]) {
		test(`select-all excludes group rows, group checkbox is tri-state @ ${viewport.label}`, async ({
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
			// Groups start collapsed, so the leaf titles aren't rendered yet — wait
			// for the group-header labels instead.
			await expect(page.getByText('qualified', { exact: true })).toBeVisible({ timeout: 10000 })

			// Plain attribute locator, not getByRole: once the bar goes `inert` (0
			// selected) it drops out of the accessibility tree, so a role-based
			// locator would stop matching it entirely.
			const bulkBar = page.locator('[aria-label="Bulk actions"]')
			const selectAll = page.getByRole('checkbox', { name: 'Select all', exact: true })

			// Regression coverage: the page-level "select all" must select exactly
			// the 3 real objects, not the 2 synthetic group rows ("status:signal",
			// "status:qualified") alongside them.
			await selectAll.click()
			await expect(bulkBar).toHaveAttribute('aria-hidden', 'false')
			await expect(page.getByLabel('3 selected')).toBeVisible()

			await selectAll.click()
			await expect(bulkBar).toHaveAttribute('aria-hidden', 'true')
			await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0)

			// Expand the "qualified" group and toggle its two leaves individually to
			// exercise the group-header checkbox's tri-state (indeterminate -> checked).
			await page.getByRole('button', { name: /qualified/i }).click()
			const qualifiedGroupCheckbox = page.getByRole('checkbox', {
				name: 'Select all in qualified',
			})
			const leafCheckboxes = page.getByRole('checkbox', { name: 'Select row' })

			await leafCheckboxes.first().click()
			await expect(page.getByLabel('1 selected')).toBeVisible()
			await expect(qualifiedGroupCheckbox).toHaveAttribute('data-state', 'indeterminate')

			await leafCheckboxes.nth(1).click()
			await expect(page.getByLabel('2 selected')).toBeVisible()
			await expect(qualifiedGroupCheckbox).toHaveAttribute('data-state', 'checked')
		})
	}
})

test.describe('Bulk-select — touch drag-select', () => {
	// T6: long-press-arm then drag across rows should select the swept range.
	test('long-press then drag selects the swept range', async ({ page, account }) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		for (let i = 1; i <= 4; i++) {
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Drag Select Bet ${i}`,
				status: 'signal',
			})
		}

		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText('Drag Select Bet 1')).toBeVisible({ timeout: 10000 })

		const checkboxes = page.getByRole('checkbox', { name: 'Select row' })
		const first = await checkboxes.nth(0).boundingBox()
		const third = await checkboxes.nth(2).boundingBox()
		if (!first || !third) throw new Error('checkbox bounding boxes not found')

		const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 }
		const end = { x: third.x + third.width / 2, y: third.y + third.height / 2 }

		await page.mouse.move(start.x, start.y)
		await page.mouse.down()
		// Long-press arm window is 500ms — hold still past the threshold before dragging.
		await page.waitForTimeout(650)
		await page.mouse.move(end.x, end.y, { steps: 5 })
		await page.mouse.up()

		await expect(page.getByLabel('3 selected')).toBeVisible({ timeout: 5000 })
	})
})
