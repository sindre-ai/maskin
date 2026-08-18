import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Covers the v2 /search screen (mockup 2522–2573): one result list spanning
// chats, loops, agents, objects and automations, grouped under mono headings,
// narrowed by a chip row of entity groups, with the nav's search field as one
// of the ways a query is committed.
//
// Every assertion drives the real UI: commit from the nav, narrow with a chip,
// click a row, then drive the no-match and idle states.

const TOKEN = 'quokkadrift'

async function waitForAppReady(page: import('@playwright/test').Page): Promise<void> {
	await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 })
}

/** Commits a query through the shared nav field (collapsed icon → inline field
 *  → Enter), which is the handoff the /search page has to survive. */
async function commitFromNav(page: import('@playwright/test').Page, query: string): Promise<void> {
	await page.getByRole('button', { name: 'Search the workspace' }).click()
	const field = page.getByRole('textbox', { name: 'Search the workspace' })
	await expect(field).toBeVisible()
	await field.fill(query)
	await field.press('Enter')
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Cross-entity search at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('a nav-committed query groups hits, chips narrow them, and a row opens', async ({
			page,
			account,
		}) => {
			const agent = await account.api.createAgentActor(`${TOKEN} Agent`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: `${TOKEN} Sweep`,
				type: 'cron',
				action_prompt: 'Sweep the backlog.',
				target_actor_id: agent.id,
				config: { expression: '0 9 * * *' },
			})
			const obj = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: `${TOKEN} Insight`,
				content: `${TOKEN} field notes`,
				status: 'new',
			})

			await page.goto(`/${account.workspaceId}`)
			await waitForAppReady(page)
			await commitFromNav(page, TOKEN)

			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/search`))
			await expect(page).toHaveURL(new RegExp(`q=${TOKEN}`))
			// The page's own input mirrors the committed query, so it can be refined.
			await expect(page.getByPlaceholder('Search everything…')).toHaveValue(TOKEN)

			// Group chips carry counts, and only groups with hits render.
			const agentsChip = page.getByRole('button', { name: /^Agents \(\d+\)$/ })
			await expect(agentsChip).toBeVisible({ timeout: 20000 })
			await expect(page.getByRole('button', { name: /^Objects \(\d+\)$/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /^Automations \(\d+\)$/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /^Loops \(/ })).toHaveCount(0)

			// Group headings and the right-aligned result line.
			await expect(page.getByRole('region', { name: 'Objects' })).toBeVisible()
			await expect(page.getByText(`"${TOKEN}"`)).toBeVisible()

			// <mark> highlighting is live on the result rows.
			await expect(page.locator('mark').first()).toBeVisible()

			// Narrowing to a group hides the others and drops the object filters.
			await agentsChip.click()
			await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible()
			await expect(page.getByRole('region', { name: 'Objects' })).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'All types' })).toHaveCount(0)

			// Back to All, then open the object row.
			await page.getByRole('button', { name: /^All \(\d+\)$/ }).click()
			await page.getByRole('button', { name: new RegExp(`${TOKEN} Insight`) }).click()
			await expect(page).toHaveURL(new RegExp(`/objects/${obj.id}`))

			// The chip row scrolls inside its own box — the page never does.
			await page.goBack()
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(1)
		})

		test('a nonsense query offers the palette; clearing lands on the idle state', async ({
			page,
			account,
		}) => {
			await page.goto(`/${account.workspaceId}/search`)
			await waitForAppReady(page)

			const input = page.getByPlaceholder('Search everything…')
			await input.fill('zzzznomatchxyz')

			await expect(page.getByText('Nothing matches "zzzznomatchxyz"')).toBeVisible({
				timeout: 20000,
			})
			await expect(
				page.getByText(/Search looks across chats, loops, agents, objects and automations/),
			).toBeVisible()

			// The action is a real, always-visible control — not a hover reveal.
			const openCommands = page.getByRole('button', { name: /Open commands/ })
			await expect(openCommands).toBeVisible()
			await openCommands.click()
			await expect(page.getByPlaceholder('Search objects, jump to a route…')).toBeVisible()
			await page.keyboard.press('Escape')

			// Clearing returns to the idle state, and the query that was just
			// committed is offered back as a RECENT pill — proving the page (not
			// the nav or the palette) owns the recents write.
			await input.fill('')
			await expect(page.getByText('Search the workspace')).toBeVisible({ timeout: 20000 })
			await expect(page.getByText('Recent')).toBeVisible()
			await expect(page.getByRole('button', { name: 'zzzznomatchxyz' })).toBeVisible()

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(1)
		})
	})
}

test.describe('Cross-entity search colour tokens', () => {
	test('the active group chip stays legible in light and dark', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `${TOKEN} Bet`,
			content: `${TOKEN} wager`,
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/search?q=${TOKEN}`)
		await waitForAppReady(page)

		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.evaluate((t) => localStorage.setItem('maskin-theme', t), scheme)
			await page.reload()

			const objectsChip = page.getByRole('button', { name: /^Objects \(\d+\)$/ })
			await expect(objectsChip).toBeVisible({ timeout: 20000 })
			await objectsChip.click()

			// The active chip is a solid dark fill, never a transparent pill that
			// reads the same as its inactive siblings.
			const [bg, fg] = await objectsChip.evaluate((el) => {
				const style = getComputedStyle(el)
				return [style.backgroundColor, style.color]
			})
			expect(bg).not.toBe('rgba(0, 0, 0, 0)')
			expect(bg).not.toBe(fg)

			await expect(page.locator('mark').first()).toBeVisible()
		}
	})
})
