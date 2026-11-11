import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

type Viewport = { width: number; height: number; label: string }

/** The page's own search: the field from md up, an icon that opens an inline field below it. */
async function openAgentsSearch(page: Page, vp: Viewport) {
	if (vp.width < 1280) await page.getByRole('button', { name: 'Search agents' }).click()
	const field = page.getByRole('searchbox', { name: 'Search agents' })
	await expect(field).toBeVisible()
	return field
}

/** Two tagged agents, one tag each, so the Team chips have something to count. */
async function seedTeams(account: { workspaceId: string; api: TestAPI }) {
	const names = ['Alpha team', 'Beta team']
	const agents: { id: string; name: string }[] = []
	for (const [i, tag] of names.entries()) {
		const agent = await account.api.createAgentActor(i === 0 ? 'Ada Atom' : 'Brian Bot')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.updateActor(agent.id, { tags: [tag] })
		agents.push({ id: agent.id, name: agent.name })
	}
	return agents
}

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
			// The first-visit default is Team; this test is about the Status groups.
			await account.api.saveDisplaySettings(account.workspaceId, 'agents', { groupBy: 'status' })

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

			// The screen publishes its title to the shared nav row, and the count
			// beside it where there is room (from xl; the viewports here are below it).
			await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()

			// The page's own search sits in the title row.
			await openAgentsSearch(page, vp)

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
			// Grouped by team the row can sit below the fold.
			await row.scrollIntoViewIfNeeded()
			const box = await row.boundingBox()
			if (!box) throw new Error('agent row has no bounding box')
			await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2)
			await expect(page).toHaveURL(new RegExp(`/agents/${ada.id}$`))
		})

		test(`search narrows the list and the Team column follows the breakpoint @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)
			const brian = await account.api.createAgentActor('Brian Bot')
			await account.api.addWorkspaceMember(account.workspaceId, brian.id)

			await page.goto(`/${account.workspaceId}/agents`)
			const adaRow = page.getByRole('link', { name: /Ada Atom/ })
			await expect(adaRow).toBeVisible({ timeout: 10_000 })

			// Agents with no tag show "No team", from the xl breakpoint up.
			const team = adaRow.getByText('No team', { exact: true })
			if (vp.width >= 1280) await expect(team).toBeVisible()
			else await expect(team).toBeHidden()

			const search = await openAgentsSearch(page, vp)
			await search.fill('brian')
			await expect(page.getByRole('link', { name: /Brian Bot/ })).toBeVisible()
			await expect(adaRow).toHaveCount(0)

			await search.fill('zzzz-nothing')
			await expect(page.getByText('No agents match.')).toBeVisible()

			await search.fill('')
			await expect(adaRow).toBeVisible()
		})

		// Mockup 2320 (group note) and 2333 ("what it's doing now").
		test(`group note and activity column at their breakpoints @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)
			await account.api.saveDisplaySettings(account.workspaceId, 'agents', { groupBy: 'status' })

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
			// from 1024px up, and neither crowds the phone layout.
			const row = page.getByRole('link', { name: /Ada Atom/ })
			const activity = row.getByText('Standing by', { exact: true }).locator('visible=true')
			const sessions = row.locator('span.tabular-nums').filter({ hasText: /^0$/ })
			// Below 1024px the Latest text is not a column but a wrapped line under
			// the outcome, so the same words are readable on touch without hover.
			await expect(activity).toBeVisible()
			if (vp.width >= 1024) {
				await expect(sessions).toBeVisible()
			} else {
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

			// The status is a pill with a dot (v11) and stays legible in both colour schemes.
			const status = row.getByText('Idle', { exact: true })
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(status).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		// The title row: page search and Display beside the shared search and New.
		test(`both searches are reachable and the page does not scroll sideways @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await seedTeams(account)
			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })

			// The header has no workspace search button; the one New chat stays on the page.
			await expect(page.getByRole('button', { name: 'Search or run a command' })).toHaveCount(0)
			await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible()
			// The page's own search: a field from xl up, an icon below it.
			if (vp.width < 1280) {
				await expect(page.getByRole('searchbox', { name: 'Search agents' })).toBeHidden()
				await expect(page.getByRole('button', { name: 'Search agents' })).toBeVisible()
			} else {
				await expect(page.getByRole('searchbox', { name: 'Search agents' })).toBeVisible()
			}
			await expect(page.getByRole('button', { name: /^Display/ })).toBeVisible()

			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

			// Opening the inline field takes over the title row, and closing it brings it back.
			if (vp.width < 1280) {
				await page.getByRole('button', { name: 'Search agents' }).click()
				const field = page.getByRole('searchbox', { name: 'Search agents' })
				await expect(field).toBeFocused()
				await field.fill('brian')
				await expect(page.getByRole('link', { name: /Ada Atom/ })).toHaveCount(0)
				await page.getByRole('button', { name: 'Close search' }).click()
				await expect(page.getByRole('button', { name: 'Search agents' })).toBeVisible()
				// The filter outlives the field.
				await expect(page.getByRole('link', { name: /Brian Bot/ })).toBeVisible()
			}
		})

		test(`first visit groups by Team, and a saved Status choice survives a reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await seedTeams(account)
			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })

			// Nothing saved: the groups are teams, A to Z, the catch-all last.
			await expect(page.getByRole('heading', { level: 3, name: 'Alpha team' })).toBeVisible()
			await expect(page.getByRole('heading', { level: 3, name: 'Beta team' })).toBeVisible()
			const headings = (await page.getByRole('heading', { level: 3 }).allTextContents()).map((h) =>
				h.replace(/\d+$/, '').trim(),
			)
			// The workspace may hold other teams, so check order, not the exact set.
			expect(headings.indexOf('Alpha team')).toBeLessThan(headings.indexOf('Beta team'))
			expect(headings.at(-1)).toBe('No team')
			expect(headings.slice(0, -1)).toEqual(
				[...headings.slice(0, -1)].sort((a, b) =>
					a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
				),
			)

			// Choose Status grouping in the Display menu; it is saved and wins on reload.
			await page.getByRole('button', { name: /^Display/ }).click()
			const saved = page.waitForResponse(
				(r) => r.url().includes('/user-display-settings/agents') && r.request().method() === 'PUT',
			)
			await page.getByText('Group by', { exact: true }).click()
			await page.getByRole('menuitem', { name: 'Status' }).click()
			await saved
			await page.keyboard.press('Escape')
			await expect(page.getByRole('heading', { level: 3, name: /^Idle/ })).toBeVisible()

			await page.reload()
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })
			await expect(page.getByRole('heading', { level: 3, name: /^Idle/ })).toBeVisible()
			await expect(page.getByRole('heading', { level: 3, name: 'Alpha team' })).toHaveCount(0)
		})

		test(`team chips filter, pills remove them and Clear all clears both @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await seedTeams(account)
			await page.goto(`/${account.workspaceId}/agents`)
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible({ timeout: 10_000 })

			// One outlined chip per team, with its count; legible in both colour schemes.
			const teams = page.getByRole('group', { name: 'Filter agents by team' })
			const alpha = teams.getByRole('button', { name: 'Alpha team (1)' })
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(alpha).toBeVisible()
				await expect(teams.getByRole('button', { name: 'Beta team (1)' })).toBeVisible()
				await expect(teams.getByRole('button', { name: /^No team \(\d+\)$/ })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// A team chip narrows the list and adds a removable pill.
			await alpha.click()
			await expect(page.getByRole('link', { name: /Ada Atom/ })).toBeVisible()
			await expect(page.getByRole('link', { name: /Brian Bot/ })).toHaveCount(0)
			await expect(page.getByText('Team:')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0)

			// Removing the pill brings everyone back.
			await page.getByRole('button', { name: 'Remove Team filter' }).click()
			await expect(page.getByRole('link', { name: /Brian Bot/ })).toBeVisible()

			// Two filters make Clear all appear, and it clears both.
			await alpha.click()
			await page
				.getByRole('group', { name: 'Filter agents by status' })
				.getByRole('button', { name: /^Idle \(\d+\)$/ })
				.click()
			await expect(page.getByText('Status:')).toBeVisible()
			await page.getByRole('button', { name: 'Clear all' }).click()
			await expect(page.getByText('Team:')).toHaveCount(0)
			await expect(page.getByText('Status:')).toHaveCount(0)
			await expect(page.getByRole('link', { name: /Brian Bot/ })).toBeVisible()
		})

		// Latest is never hover-only: on md+ a tooltip carries the full text, below
		// md the text wraps under the outcome.
		test(`Latest text is reachable without hover @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ada = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, ada.id)

			await page.goto(`/${account.workspaceId}/agents`)
			const row = page.getByRole('link', { name: /Ada Atom/ })
			await expect(row).toBeVisible({ timeout: 10_000 })
			const latest = row.getByText('Standing by', { exact: true }).locator('visible=true')

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(latest).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			if (vp.width >= 1024) {
				await latest.hover()
				await expect(page.getByRole('tooltip')).toContainText('Standing by')
			}

			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1)
		})
	}
})
