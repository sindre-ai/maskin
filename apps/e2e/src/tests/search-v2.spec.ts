import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The v2 search page behind the search-v2 flag (bet "Search that narrows as you
// type"). One flow per ship-gate viewport: type a word, Tab turns it into a pill,
// the status row narrows it, the URL carries the state and a reload restores it,
// a result opens, and the analytics events show up. The flag is switched on with
// the test-only localStorage override, so the old page stays covered by
// search-cross-entity.spec.ts.

const TOKEN = 'quokkadrift'

/** Collects the analytics events the app logs while no PostHog key is set. */
function collectAnalytics(page: Page): () => string[] {
	const events: string[] = []
	page.on('console', (msg) => {
		const text = msg.text()
		if (text.startsWith('[analytics]')) events.push(text)
	})
	return () => events
}

const eventNamed = (events: string[], name: string) =>
	events.filter((e) => e.includes(`name: ${name}`))

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Search v2 at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('a typed type word becomes a pill, the URL carries it, and a reload restores it', async ({
			page,
			account,
		}) => {
			await page.addInitScript(() => {
				localStorage.setItem('ff:search-v2', 'on')
			})
			const events = collectAnalytics(page)

			const agent = await account.api.createAgentActor(`${TOKEN} Agent`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: `${TOKEN} Insight`,
				content: `${TOKEN} field notes`,
				status: 'new',
			})

			await page.goto(`/${account.workspaceId}/search`)
			const field = page.getByRole('combobox', { name: 'Search' })
			await expect(field).toBeVisible({ timeout: 15_000 })

			// A type word only offers a suggestion; Tab makes it a pill.
			await field.fill(`${TOKEN} agent`)
			await expect(page.getByRole('button', { name: /^Filter by Agents/ })).toBeVisible()
			await field.press('Tab')
			const pill = page.getByRole('button', { name: 'Remove filter: Agents, typed as agent' })
			await expect(pill).toBeVisible()

			// The URL carries the words and the pill.
			await expect(page).toHaveURL(new RegExp(`q=${TOKEN}`))
			await expect(page).toHaveURL(/types=agent/)

			// Counts come from the endpoint: one agent, one result.
			const typeChips = page.getByRole('group', { name: 'Filter by type' })
			await expect(typeChips.getByRole('button', { name: 'Agents (1)' })).toBeVisible({
				timeout: 20_000,
			})
			await expect(page.getByText(/^1 result for/)).toBeVisible()
			await expect(page.getByRole('option', { name: new RegExp(`${TOKEN} Agent`) })).toBeVisible()

			// Chips are 44px on touch viewports and reachable by keyboard.
			const chipBox = await typeChips.getByRole('button', { name: 'Agents (1)' }).boundingBox()
			expect(chipBox?.height).toBeGreaterThanOrEqual(44)
			await typeChips.getByRole('button', { name: 'Agents (1)' }).focus()
			await expect(typeChips.getByRole('button', { name: 'Agents (1)' })).toBeFocused()

			// The status row narrows by group. An idle agent is In progress.
			const statusChips = page.getByRole('group', { name: 'Filter by status' })
			await statusChips.getByRole('button', { name: /^In progress/ }).click()
			await expect(page).toHaveURL(/statuses=in_progress/)

			// A reload restores the same view.
			await page.reload()
			await expect(
				page.getByRole('button', { name: 'Remove filter: Agents, typed as agent' }),
			).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Remove filter: Agents' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByRole('button', { name: 'Remove filter: In progress' })).toBeVisible()
			await expect(page.getByRole('combobox', { name: 'Search' })).toHaveValue(TOKEN)
			await expect(page.getByRole('option', { name: new RegExp(`${TOKEN} Agent`) })).toBeVisible()

			// Open the result.
			await page.getByRole('option', { name: new RegExp(`${TOKEN} Agent`) }).click()
			await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}`))

			// The events arrived, with the v2 fields and no query text.
			const performed = eventNamed(events(), 'search_performed')
			expect(performed.length).toBeGreaterThan(0)
			expect(performed.some((e) => e.includes('ui_version: v2'))).toBe(true)
			expect(eventNamed(events(), 'search_filter_changed').length).toBeGreaterThan(0)
			const opened = eventNamed(events(), 'search_result_opened')
			expect(opened.length).toBeGreaterThan(0)
			expect(opened[opened.length - 1]).toContain('ui_version: v2')
			expect(events().some((e) => e.includes(TOKEN))).toBe(false)
		})

		test('Backspace at the start turns the pill back into its word', async ({ page, account }) => {
			await page.addInitScript(() => {
				localStorage.setItem('ff:search-v2', 'on')
			})
			await page.goto(`/${account.workspaceId}/search`)
			const field = page.getByRole('combobox', { name: 'Search' })
			await expect(field).toBeVisible({ timeout: 15_000 })

			await field.fill(`${TOKEN} agent`)
			await field.press('Tab')
			await expect(
				page.getByRole('button', { name: 'Remove filter: Agents, typed as agent' }),
			).toBeVisible()

			await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0))
			await field.press('Backspace')
			await expect(page.getByRole('button', { name: /Remove filter/ })).toHaveCount(0)
			await expect(field).toHaveValue(`${TOKEN} agent`)
		})

		test('a zero-result query with a status word names it and offers the chip', async ({
			page,
			account,
		}) => {
			await page.addInitScript(() => {
				localStorage.setItem('ff:search-v2', 'on')
			})
			await page.goto(`/${account.workspaceId}/search?q=nomatchzzz%20active`)
			await expect(page.getByText('“active” is a status.', { exact: false })).toBeVisible({
				timeout: 20_000,
			})
			await expect(page.getByRole('button', { name: 'Filter by In progress' }).last()).toBeVisible()
			// The page has no horizontal scroll at any viewport.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	})
}
