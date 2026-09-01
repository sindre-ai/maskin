import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agents index', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`grouped sections and Display-menu status filter @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)
			const brian = await account.api.createAgentActor('Brian Bot')
			await account.api.addWorkspaceMember(account.workspaceId, brian.id)

			await page.goto(`/${account.workspaceId}/agents`)

			// With no sessions seeded both seeded agents land in Idle. Working has
			// no rows, so it keeps its per-group empty state; Failed can hold a
			// row from the workspace's default agent roster, so only assert that
			// the group renders.
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('link', { name: /Brian Bot/ })).toBeVisible()
			await expect(page.getByRole('heading', { name: /^Working$/ })).toBeVisible()
			await expect(page.getByText('No working agents right now.')).toBeVisible()
			await expect(page.getByRole('heading', { name: /^Failed$/ })).toBeVisible()

			// The grouped sections and agent rows render in both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('heading', { name: /^Idle$/ })).toBeVisible()
				await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Filter to Idle via the Display menu — Working/Failed disappear —
			// and the status choice survives a reload via per-actor persistence.
			await page.getByRole('button', { name: /^Display/ }).click()
			// Matched loosely on purpose: the row's accessible name carries both the
			// axis and its current summary, and only this row has both.
			const statusRow = page.getByRole('button', { name: /Status.*All/ })
			await statusRow.click()
			// Register before the toggle so the debounced 500ms write-through
			// cannot be missed.
			const settingsSaved = page.waitForResponse(
				(r) => r.url().includes('/user-display-settings/agents') && r.request().method() === 'PUT',
			)
			await page
				.locator('div', { has: statusRow })
				.last()
				.getByRole('button', { name: /^Idle/ })
				.click()
			await settingsSaved
			// The panel stays open for multi-select, and at 375px it is a bottom
			// sheet covering the list — dismiss it before reading the result.
			await page.keyboard.press('Escape')

			// Below 768px the Display panel is a modal Sheet, which aria-hides the
			// rest of the page — every role query below would resolve to nothing
			// while it is open. Dismiss it before asserting on the list.
			await page.keyboard.press('Escape')
			// Not `exact`: a filter is applied by now, so the trigger carries its
			// active-filter count and its accessible name is "Display 1".
			await expect(page.getByRole('button', { name: /^Display/ })).toBeVisible()

			await expect(page.getByRole('heading', { name: /^Working$/ })).not.toBeVisible()
			await expect(page.getByRole('heading', { name: /^Failed$/ })).not.toBeVisible()
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible()

			await page.reload()
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('heading', { name: /^Idle$/ })).toBeVisible()
			await expect(page.getByRole('heading', { name: /^Working$/ })).not.toBeVisible()
		})

		test(`nav row title, status chip strip and whole-row click @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)
			const brian = await account.api.createAgentActor('Brian Bot')
			await account.api.addWorkspaceMember(account.workspaceId, brian.id)

			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })

			// The screen publishes its title (and, where there is room, its count)
			// to the shared nav row.
			await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
			if (vp.width >= 640) {
				// Every workspace also ships the built-in Workspace Coach, so the
				// count is "the agents that exist", not just the two seeded here.
				await expect(page.getByText(/\d+ agents · each owns one outcome/)).toBeVisible()
			}

			// There is no per-screen search input — workspace search lives in the nav.
			await expect(page.getByRole('searchbox', { name: 'Search agents' })).toHaveCount(0)

			// The chip strip is reachable on touch at every viewport (no hover reveal),
			// and legible in both colour schemes.
			const strip = page.getByRole('group', { name: 'Filter agents by status' })
			const allChip = strip.getByRole('button', { name: /^All \(\d+\)$/ })
			const workingChip = strip.getByRole('button', { name: 'Working (0)' })
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(allChip).toBeVisible()
				await expect(workingChip).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Selecting Working empties the list; the counts stay pre-filter.
			await workingChip.click()
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toHaveCount(0)
			await expect(page.getByText('No agents in that state right now.')).toBeVisible()
			// Counts are computed pre-filter, so they do not move when a chip is on.
			await expect(allChip).toBeVisible()
			await expect(workingChip).toHaveAttribute('aria-pressed', 'true')

			await allChip.click()
			const row = page.getByRole('link', { name: /Ada Atom/ })
			await expect(row).toBeVisible()

			// The whole row is the click target — click its far right edge, well
			// away from the name, and land on the agent.
			const box = await row.boundingBox()
			if (!box) throw new Error('agent row has no bounding box')
			await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2)
			await expect(page).toHaveURL(new RegExp(`/agents/${ada.id}$`))
		})

		// Mockup 2320 (group note) and 2333 ("what it's doing now").
		test(`group note and activity column at their breakpoints @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)

			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })

			// The note explaining the group rides beside the count at every width.
			const note = page.getByText('Standing by for their next run')
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(note).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// The activity and session columns share one breakpoint — both appear
			// from 768px up, and neither crowds the phone layout.
			const row = page.getByRole('link', { name: /Ada Atom/ })
			const activity = row.getByText('Standing by', { exact: true })
			const sessions = row.getByText('0 sessions')
			if (vp.width >= 768) {
				await expect(activity).toBeVisible()
				await expect(sessions).toBeVisible()
			} else {
				await expect(activity).toBeHidden()
				await expect(sessions).toBeHidden()
			}
		})

		// Mockup 2327–2337 — the v2 row chrome: an unframed column of rows on the
		// page background, a solid identity plate, and a plate-less status.
		test(`v2 row chrome — flat rows, solid avatar, inline status @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)

			await page.goto(`/${account.workspaceId}/agents`)
			const row = page.getByRole('link', { name: /Ada Atom/ })
			await expect(row).toBeVisible({ timeout: 10_000 })

			// The row list carries no card frame of its own — the group's <ul> has
			// no border, so the rows read as one column rather than a stack of
			// panels. Rows are separated by the subtle hairline instead.
			const list = page.locator('ul', { has: row }).last()
			await expect(list).toHaveCSS('border-bottom-width', '0px')
			const item = page.locator('li', { has: row }).last()
			await expect(item).toHaveCSS('border-bottom-width', '1px')

			// The status is a dot and a coloured word, not a filled pill, and it
			// stays legible in both colour schemes.
			const status = row.getByText('Idle', { exact: true })
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(status).toBeVisible()
				await expect(status).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
