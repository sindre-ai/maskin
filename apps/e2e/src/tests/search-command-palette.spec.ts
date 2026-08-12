import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Search direction 1 (bet `search-command-palette`): the ⌘K palette and the
// /search view share one query engine. These specs pin the interaction
// contract at the three ship-gate viewports — palette open/find/Enter-through,
// the See-all handoff to /search, filter chips, <mark> highlighting, recents,
// and keyboard hygiene (⌘F override, Esc clear-then-close).

// On-wire probe for the success-metric funnel. Mirrors the console-fallback
// approach used by nav-item-clicked.spec.ts / scroll-to-top.spec.ts: the dev
// stack runs without VITE_POSTHOG_KEY, so posthog-js stays uninitialised and
// `trackEvent` logs `[analytics] <payload>` to the browser console instead of
// firing an XHR. The payload shape is identical to the PostHog wire shape, so
// console-line assertions prove the measurement contract (`command_palette_opened`
// denominator, `search_result_opened` numerator) without needing PostHog
// reachable from CI.
interface AnalyticsPayload {
	name: string
	surface?: string
	entity_id?: string
	entity_type?: string
}

function collectAnalytics(page: import('@playwright/test').Page): AnalyticsPayload[] {
	const calls: AnalyticsPayload[] = []
	page.on('console', (msg) => {
		if (msg.type() !== 'info') return
		const args = msg.args()
		if (args.length < 2) return
		Promise.all(args.map((a) => a.jsonValue().catch(() => null)))
			.then((values) => {
				const [tag, payload] = values as [unknown, AnalyticsPayload | null]
				if (tag === '[analytics]' && payload && typeof payload === 'object') {
					calls.push(payload)
				}
			})
			.catch(() => {})
	})
	return calls
}

// The ⌘K/⌘F/Esc listeners live on <CommandPalette>, which only mounts once the
// authed layout has loaded the workspace — until then `_authed/$workspaceId.tsx`
// returns a bare "Loading workspace…" shell with no header and no palette.
// Playwright's `keyboard.press` is a raw synthetic event with no actionability
// wait, so firing ⌘K straight after navigation can hit the shell before the
// listener exists and be silently dropped. Wait for the header (rendered with
// the layout) before injecting a shortcut, matching the ready-wait pattern used
// by the other layout-based specs (nav-item-clicked, header-new-menu).
async function waitForAppReady(page: import('@playwright/test').Page): Promise<void> {
	await expect(page.locator('header').first()).toBeVisible({ timeout: 15_000 })
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Search + command palette at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('⌘K opens the palette, typing finds an object, Enter opens it', async ({
			page,
			account,
		}) => {
			const analyticsCalls = collectAnalytics(page)
			const obj = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Quasiprime Insight',
				content: 'quasiprime knowledge base draft',
				status: 'new',
			})

			await page.goto(`/${account.workspaceId}`)
			await waitForAppReady(page)
			await page.keyboard.press('Control+KeyK')

			const input = page.getByPlaceholder('Search or jump to…')
			await expect(input).toBeVisible()
			await input.fill('quasiprime')
			await expect(page.getByText('Quasiprime Insight')).toBeVisible({ timeout: 10000 })

			await page.keyboard.press('Enter')
			await expect(page).toHaveURL(new RegExp(`/objects/${obj.id}`))

			// Allow the console-fallback microtask to settle.
			await page.waitForTimeout(200)

			// The success-metric funnel fired on the wire: one palette open on
			// ⌘K, one result open via Enter — both with the measured event names.
			const paletteOpens = analyticsCalls.filter((c) => c.name === 'command_palette_opened')
			expect(paletteOpens).toHaveLength(1)
			expect(paletteOpens[0]).toMatchObject({ surface: 'command_palette' })

			const resultOpens = analyticsCalls.filter((c) => c.name === 'search_result_opened')
			expect(resultOpens).toHaveLength(1)
			expect(resultOpens[0]).toMatchObject({
				entity_id: obj.id,
				entity_type: 'insight',
				surface: 'command_palette',
			})
		})

		test('See all hands off to /search; type chips filter; <mark> highlights in light + dark', async ({
			page,
			account,
		}) => {
			await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Asteroid Insight',
				content: 'asteroid miner survey notes',
				status: 'new',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Asteroid Bet',
				content: 'asteroid vector bet notes',
				status: 'active',
			})

			const analyticsCalls = collectAnalytics(page)

			await page.goto(`/${account.workspaceId}`)
			await waitForAppReady(page)
			await page.keyboard.press('Control+KeyK')
			await page.getByPlaceholder('Search or jump to…').fill('asteroid')

			await page.getByRole('button', { name: /See all/ }).click()
			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/search`))
			await expect(page).toHaveURL(/q=asteroid/)
			await expect(page.getByPlaceholder('Search everything…')).toHaveValue('asteroid')

			// The See-all footer's /search arrival produces its own palette-open
			// event (search_view surface), per the success-metric funnel's
			// denominator covering both entry points.
			await page.waitForTimeout(200)
			const viewOpens = analyticsCalls.filter(
				(c) => c.name === 'command_palette_opened' && c.surface === 'search_view',
			)
			expect(viewOpens).toHaveLength(1)

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
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(1)

			// Confirms the insight is still reachable after filtering.
			await expect(page.getByRole('button', { name: /Asteroid Insight/ })).not.toBeVisible()
			await page.getByRole('button', { name: 'All types' }).click()
			await expect(page.getByRole('button', { name: /Asteroid Insight/ })).toBeVisible()
			await expect(page.getByText('“asteroid”')).toBeVisible()
		})

		test('opened objects surface in /search recents; ⌘F reopens; Esc clears then closes', async ({
			page,
			account,
		}) => {
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Comet Task',
				content: 'comet approach tracking task',
				status: 'todo',
			})

			await page.goto(`/${account.workspaceId}`)
			await waitForAppReady(page)
			await page.keyboard.press('Control+KeyK')
			await page.getByPlaceholder('Search or jump to…').fill('comet')
			await expect(page.getByText('Comet Task')).toBeVisible({ timeout: 10000 })
			await page.getByText('Comet Task').click()
			await expect(page).toHaveURL(new RegExp(`/objects/${task.id}`))

			// Empty /search shows the just-opened object under Recent objects.
			await page.goto(`/${account.workspaceId}/search`)
			await waitForAppReady(page)
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
