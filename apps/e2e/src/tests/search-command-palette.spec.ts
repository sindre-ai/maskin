import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Search direction 1 (bet `search-command-palette`): the ⌘K palette and the
// /search view share one query engine. These specs pin the interaction
// contract at the three ship-gate viewports — palette open/find/Enter-through,
// the See-all handoff to /search, filter chips, <mark> highlighting, recents,
// and keyboard hygiene (⌘F override, Esc clear-then-close).

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Search + command palette at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('⌘K opens the palette, typing finds an object, Enter opens it', async ({ page, account }) => {
			const obj = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Quasiprime Insight',
				content: 'quasiprime knowledge base draft',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}`)
			await page.keyboard.press('Control+KeyK')

			const input = page.getByPlaceholder('Search or jump to…')
			await expect(input).toBeVisible()
			await input.fill('quasiprime')
			await expect(page.getByText('Quasiprime Insight')).toBeVisible({ timeout: 10000 })

			await page.keyboard.press('Enter')
			await expect(page).toHaveURL(new RegExp(`/objects/${obj.id}`))
		})

		test('See all hands off to /search; type chips filter; <mark> highlights in light + dark', async ({
			page,
			account,
		}) => {
			const insight = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Asteroid Insight',
				content: 'asteroid miner survey notes',
				status: 'active',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Asteroid Bet',
				content: 'asteroid vector bet notes',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}`)
			await page.keyboard.press('Control+KeyK')
			await page.getByPlaceholder('Search or jump to…').fill('asteroid')

			await page.getByRole('button', { name: /See all/ }).click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/search`))
			await expect(page).toHaveURL(/q=asteroid/)
			await expect(page.getByPlaceholder('Search everything…')).toHaveValue('asteroid')

			const insightRow = page.getByRole('button', { name: /Asteroid Insight/ })
			const betRow = page.getByRole('button', { name: /Asteroid Bet/ })
			await expect(insightRow).toBeVisible({ timeout: 10000 })
			await expect(betRow).toBeVisible()

			// Type chip narrows the result set (T3 filter contract).
			await page.getByRole('button', { name: 'Bet' }).click()
			await expect(betRow).toBeVisible()
			await expect(insightRow).not.toBeVisible()

			// <mark> rendering in both themes — the highlight color must never
			// become invisible (mark styling lives in app.css as a custom token).
			await page.getByRole('button', { name: 'All types' }).click()
			await expect(betRow).toBeVisible()
			for (const scheme of ['light', 'dark'] as const) {
				await page.evaluate((t) => localStorage.setItem('maskin-theme', t), scheme)
				await page.reload()
				const mark = page.locator('mark').first()
				await expect(mark).toBeVisible({ timeout: 10000 })
				const bg = await mark.evaluate((el) => getComputedStyle(el).backgroundColor)
				expect(bg).not.toBe('rgba(0, 0, 0, 0)')
			}

			// The page itself never overflows horizontally — the chip row scrolls
			// inside its own box (the scrollable-filter-row contract).
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(1)

			// Confirms the insight is still reachable after filtering.
			await expect(page.getByRole('button', { name: /Asteroid Insight/ })).not.toBeVisible()
			await page.getByRole('button', { name: 'All types' }).click()
			await expect(page.getByRole('button', { name: /Asteroid Insight/ })).toBeVisible()
			await expect(page.getByText(`“asteroid”`)).toBeVisible()
		})

		test('opened objects surface in /search recents; ⌘F reopens; Esc clears then closes', async ({
			page,
			account,
		}) => {
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Comet Task',
				content: 'comet approach tracking task',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}`)
			await page.keyboard.press('Control+KeyK')
			await page.getByPlaceholder('Search or jump to…').fill('comet')
			await expect(page.getByText('Comet Task')).toBeVisible({ timeout: 10000 })
			await page.getByText('Comet Task').click()
			await expect(page).toHaveURL(new RegExp(`/objects/${task.id}`))

			// Empty /search shows the just-opened object under Recent objects.
			await page.goto(`/${account.workspaceId}/search`)
			await expect(page.getByRole('region', { name: 'Recent objects' })).toBeVisible()
			await expect(
				page.getByRole('region', { name: 'Recent objects' }).getByText('Comet Task'),
			).toBeVisible()

			// ⌘F override: opens search instead of find-in-page.
			await page.keyboard.press('Control+KeyF')
			const input = page.getByPlaceholder('Search or jump to…')
			await expect(input).toBeVisible()

			// First Esc clears a query, second closes (the SearchView input has
			// focus nowhere near these keys, so no stray navigation happens).
			await input.fill('comet')
			await page.keyboard.press('Escape')
			await expect(input).toHaveValue('')
			await page.keyboard.press('Escape')
			await expect(input).not.toBeVisible()
		})
	})
}