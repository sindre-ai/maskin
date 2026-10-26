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

type AnalyticsEvent = Record<string, unknown>

/**
 * Collects the analytics events the app logs while no PostHog key is set. The
 * payload is read from the console message's second argument: msg.text() cuts a
 * logged object to a five-property preview, which drops the later fields.
 */
function collectAnalytics(page: Page): () => AnalyticsEvent[] {
	const events: AnalyticsEvent[] = []
	page.on('console', async (msg) => {
		if (!msg.text().startsWith('[analytics]')) return
		try {
			const payload = await msg.args()[1]?.jsonValue()
			if (payload && typeof payload === 'object') events.push(payload as AnalyticsEvent)
		} catch {
			// The page moved on before the payload could be read.
		}
	})
	return () => events
}

const eventNamed = (events: AnalyticsEvent[], name: string) => events.filter((e) => e.name === name)

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
			await expect
				.poll(() => eventNamed(events(), 'search_performed').some((e) => e.ui_version === 'v2'))
				.toBe(true)
			await expect
				.poll(() => eventNamed(events(), 'search_filter_changed').length)
				.toBeGreaterThan(0)
			await expect
				.poll(() => eventNamed(events(), 'search_result_opened').some((e) => e.ui_version === 'v2'))
				.toBe(true)
			expect(JSON.stringify(events()).includes(TOKEN)).toBe(false)
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

/**
 * Opens the workspace on a page that is not Search and presses ⌘K. The key is waited
 * for: the launcher's listener exists only once the shell has read the flag, which
 * the header's one search button shows.
 */
async function openLauncher(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/objects`)
	await expect(page.getByRole('button', { name: 'Search or run a command' })).toBeVisible({
		timeout: 20_000,
	})
	await page.keyboard.press('ControlOrMeta+k')
	return page.getByRole('dialog', { name: 'Command palette' })
}

// The same field in the ⌘K launcher: the pills behave as on the page, and Enter on the
// Search row (or ⌘↵) hands the words and the pills to /search.
for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Search v2 launcher at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test.beforeEach(async ({ page }) => {
			await page.addInitScript(() => {
				localStorage.setItem('ff:search-v2', 'on')
			})
		})

		test('a typed type word becomes a pill in the launcher and lands on the page as the same pill', async ({
			page,
			account,
		}) => {
			const events = collectAnalytics(page)
			const agent = await account.api.createAgentActor(`${TOKEN} Agent`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const panel = await openLauncher(page, account.workspaceId)
			await expect(panel).toBeVisible({ timeout: 15_000 })
			const field = panel.getByRole('combobox', { name: 'Search or run a command' })
			await expect(field).toBeFocused()

			// A type word only offers a suggestion; Tab makes it a pill. The launcher's own
			// Tab trap does not swallow it, and focus stays in the field.
			await field.fill(`${TOKEN} agent`)
			await expect(panel.getByRole('button', { name: /^Filter by Agents/ })).toBeVisible()
			await field.press('Tab')
			await expect(
				panel.getByRole('button', { name: 'Remove filter: Agents, typed as agent' }),
			).toBeVisible()
			await expect(field).toBeFocused()

			// A pill hides Commands and Go to; the endpoint's rows are under Jump to.
			await expect(panel.getByRole('group', { name: 'Commands' })).toHaveCount(0)
			await expect(panel.getByRole('group', { name: 'Go to' })).toHaveCount(0)
			// The Search row shows its match count once the answer for these words and this pill
			// is in. Until then the rows on screen are the previous answer, and Enter ignores them.
			await expect(
				panel.getByRole('option', { name: /Search everything for .*1 match/ }),
			).toBeVisible({
				timeout: 20_000,
			})
			await expect(panel.getByRole('option', { name: /Agent AGENT/ })).toBeVisible()
			await expect(panel.getByRole('option', { name: /CHAT/ })).toHaveCount(0)

			// ⌘↵ hands over: the page opens with the same words and pill.
			await field.press('ControlOrMeta+Enter')
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/search\\?`))
			await expect(page).toHaveURL(new RegExp(`q=${TOKEN}`))
			await expect(page).toHaveURL(/types=agent/)
			await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Remove filter: Agents' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByRole('combobox', { name: 'Search' })).toHaveValue(TOKEN)
			await expect(page.getByRole('option', { name: new RegExp(`${TOKEN} Agent`) })).toBeVisible({
				timeout: 20_000,
			})

			// The launcher's events carry its own surface, the v2 marker and no query text.
			await expect
				.poll(() =>
					eventNamed(events(), 'search_performed').some(
						(e) => e.surface === 'command_palette' && e.ui_version === 'v2',
					),
				)
				.toBe(true)
			expect(JSON.stringify(events()).includes(TOKEN)).toBe(false)
		})

		test('Esc clears the words, then the pills, then closes, and Enter opens the top row', async ({
			page,
			account,
		}) => {
			const agent = await account.api.createAgentActor(`${TOKEN} Agent`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			const panel = await openLauncher(page, account.workspaceId)
			const field = panel.getByRole('combobox', { name: 'Search or run a command' })
			await expect(field).toBeFocused({ timeout: 15_000 })

			await field.fill(`${TOKEN} agent`)
			await field.press('Tab')
			await expect(panel.getByRole('button', { name: /Remove filter: Agents/ })).toBeVisible()
			await field.pressSequentially(' more')

			await field.press('Escape')
			await expect(field).toHaveValue('')
			await expect(panel.getByRole('button', { name: /Remove filter: Agents/ })).toBeVisible()
			await field.press('Escape')
			await expect(panel.getByRole('button', { name: /Remove filter/ })).toHaveCount(0)
			await expect(panel).toBeVisible()
			await field.press('Escape')
			await expect(panel).toHaveCount(0)

			// Enter opens the highlighted result, once the answer for the typed words is in.
			await page.keyboard.press('ControlOrMeta+k')
			await field.fill(`${TOKEN} agent`)
			await field.press('Tab')
			await expect(
				panel.getByRole('option', { name: /Search everything for .*1 match/ }),
			).toBeVisible({
				timeout: 20_000,
			})
			await expect(panel.getByRole('option', { name: /Agent AGENT/ })).toBeVisible()
			await field.press('Enter')
			await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}`))
		})

		test('an empty launcher leads with Needs you; the nav has one search button; ⌘F is left to the browser outside Search', async ({
			page,
			account,
		}) => {
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: `${TOKEN} review me`,
				content: 'waiting on a person',
				status: 'todo',
			})
			// The API rejects tasks created past their entry status, so move it after creation.
			await account.api.updateObject(task.id, account.workspaceId, { status: 'in_review' })

			await page.goto(`/${account.workspaceId}/objects`)

			// One nav entry. The words show from 1024px; under it the button is the icon only.
			const navButton = page.getByRole('button', { name: 'Search or run a command' })
			await expect(navButton).toBeVisible({ timeout: 15_000 })
			await expect(page.getByRole('textbox', { name: 'Search the workspace' })).toHaveCount(0)
			const navLabel = navButton.getByText('Search or run a command')
			if (vp.width >= 1024) await expect(navLabel).toBeVisible()
			else await expect(navLabel).toBeHidden()

			// ⌘F is not taken here, so the browser's find works.
			const prevented = () =>
				page.evaluate(() => {
					const event = new KeyboardEvent('keydown', {
						key: 'f',
						ctrlKey: true,
						metaKey: true,
						cancelable: true,
					})
					document.dispatchEvent(event)
					return event.defaultPrevented
				})
			expect(await prevented()).toBe(false)

			await navButton.click()
			const panel = page.getByRole('dialog', { name: 'Command palette' })
			await expect(panel.getByRole('group', { name: 'Needs you' })).toBeVisible({ timeout: 20_000 })
			await expect(
				panel.getByRole('group', { name: 'Needs you' }).getByRole('option', {
					name: new RegExp(`${TOKEN} review me`),
				}),
			).toBeVisible()
			const labels = await panel
				.getByRole('group')
				.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
			expect(labels.indexOf('Needs you')).toBe(0)
			expect(labels).toEqual(expect.arrayContaining(['Commands', 'Go to', 'Search']))
			expect(labels).not.toContain('Jump to')
			await page.keyboard.press('Escape')
			await expect(panel).toHaveCount(0)

			// On Search the key focuses the page's field.
			await page.goto(`/${account.workspaceId}/search`)
			await expect(page.getByRole('combobox', { name: 'Search' })).toBeVisible({ timeout: 15_000 })
			await page.getByRole('combobox', { name: 'Search' }).evaluate((el) => el.blur())
			await expect(page.getByRole('combobox', { name: 'Search' })).not.toBeFocused()
			expect(await prevented()).toBe(true)
			await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused()
			// The nav shows no search button on Search: the page is the search.
			await expect(navButton).toHaveCount(0)
		})
	})
}
