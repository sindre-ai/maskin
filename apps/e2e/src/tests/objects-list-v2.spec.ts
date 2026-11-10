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

		test(`title-row search wires the list, and both searches are reachable with no sideways scroll at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Alpha plan',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Zulu plan',
				status: 'active',
			})
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Alpha plan')).toBeVisible({ timeout: 15000 })

			// The header has no workspace search button; the one New stays beside the page's own search.
			await expect(page.getByRole('button', { name: 'Search or run a command' })).toHaveCount(0)
			await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible()
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

			// A field from xl up, an icon below it that opens an inline field.
			if (vp.width < 1280) {
				await expect(page.getByRole('searchbox', { name: 'Search items' })).toBeHidden()
				await page.getByRole('button', { name: 'Search items' }).click()
			}
			const search = page.getByRole('searchbox', { name: 'Search items' })
			await expect(search).toBeVisible()
			await search.fill('zulu')
			await expect(page.getByText('Zulu plan')).toBeVisible()
			await expect(page.getByText('Alpha plan')).toHaveCount(0)
			await expect(page).toHaveURL(/q=zulu/)

			await search.fill('')
			await expect(page.getByText('Alpha plan')).toBeVisible()
			await expect(page).not.toHaveURL(/q=/)
		})

		test(`rows carry a type glyph named for the type at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Glyph bet',
				status: 'active',
			})
			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Glyph bet')).toBeVisible({ timeout: 15000 })
			const row = page.locator('[data-obj-id]', { hasText: 'Glyph bet' })
			await expect(row.getByRole('img', { name: /^bets?$/i })).toBeVisible()
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(row.getByRole('img', { name: /^bets?$/i })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		test(`type chips fold into More only when they do not fit at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			for (const [type, status] of [
				['bet', 'active'],
				['task', 'todo'],
				['insight', 'new'],
			] as const) {
				await account.api.createObject(account.workspaceId, {
					type,
					title: `Fold ${type}`,
					status,
				})
			}
			await page.goto(`/${account.workspaceId}/objects`)
			const chips = page.getByRole('group', { name: 'Type filter' })
			await expect(chips.getByRole('button', { name: /^All \(\d+\)$/ })).toBeVisible({
				timeout: 15000,
			})

			const more = chips.getByRole('button', { name: /^More \(\d+\)$/ })
			if (vp.width < 768) {
				// 375px: not every chip fits the row, so the rest sit behind More.
				await expect(more).toBeVisible()
				await more.click()
				const folded = page.getByRole('menuitemradio').first()
				await expect(folded).toBeVisible()
				await folded.click()
				await expect(page).toHaveURL(/type=/)
			} else {
				// 768px and up: every object-type chip stays in the row.
				await expect(chips.getByRole('button', { name: /^Tasks \(\d+\)$/ })).toBeVisible()
				await expect(chips.getByRole('button', { name: /^Bets \(\d+\)$/ })).toBeVisible()
				if (vp.width < 1024) {
					// The trailing Files chip is the one that no longer fits beside the
					// sidebar at iPad portrait, so it alone sits behind More.
					await expect(more).toHaveText(/^More/)
					await more.click()
					await expect(page.getByRole('menuitemradio')).toHaveText([/^Files/])
					await page.keyboard.press('Escape')
				} else {
					await expect(more).toHaveCount(0)
				}
			}
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)
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

			// View rows first, then the sections.
			await expect(page.getByRole('button', { name: /View: List/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /View: Board/ })).toBeVisible()
			await expect(page.getByText('Filters', { exact: true })).toBeVisible()
			await expect(page.getByText('Properties', { exact: true })).toBeVisible()
			await expect(page.getByText('Show archived', { exact: true })).toBeVisible()
			await expect(page.getByText('Reset all', { exact: true })).toBeVisible()
		})

		test(`the list rests grouped by status, groups open, at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Active flat bet',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Done flat bet',
				status: 'succeeded',
			})

			// No groupBy in the URL and nothing saved — the v11 resting state is Group by Status.
			await page.goto(`/${account.workspaceId}/objects?type=bet`)

			// Both rows are reachable at once, each under its own open status group.
			await expect(page.getByText('Active flat bet')).toBeVisible({ timeout: 15000 })
			await expect(page.getByText('Done flat bet')).toBeVisible()
			await expect(page.getByRole('button', { expanded: true, name: /active/i })).toHaveCount(1)
			await expect(page.getByRole('button', { expanded: false, name: /active/i })).toHaveCount(0)
		})

		test(`choosing Group by State still groups the list, groups open, at ${vp.label}`, async ({
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

			// An explicit State grouping is an explicit choice and is honoured.
			await page.goto(`/${account.workspaceId}/objects?type=bet&groupBy=status`)

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
				status: 'opportunity',
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
			await page.getByRole('button', { name: /View: Board/ }).click()

			await expect(page.getByTestId('board-view')).toBeVisible({ timeout: 15000 })
			// Every status after the first has no cards yet.
			await expect(page.getByText('Drop here').first()).toBeVisible()

			// The advance affordance must be reachable without hover — touch
			// viewports have none (see .claude/rules/verification.md).
			await expect(page.getByRole('button', { name: /^Move to / }).first()).toBeVisible()
		})
	}
})
