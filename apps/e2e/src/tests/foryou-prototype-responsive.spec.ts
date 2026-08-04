import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// T5 of bet `foryou-prototype-redesign` (Direction A): responsive layout at
// 375 / 768 / 1024 and swipe-gesture regression against T3's card
// restructuring. One focused pass per AC bullet — this is the ship-gate
// regression harness the umbrella PR runs before merging, not an exhaustive
// visual suite.
//
// The unread feed is mocked so the three card kinds land deterministically —
// one Decision, one Sign-off, one Proposed-bet — driven by `object.type` on
// each row. That keeps the layout assertions stable across CI runs regardless
// of what the seeded workspace happens to have.
//
// Prototype-redesign selectors this spec relies on (T2/T3/T4 must expose
// them — see PR body's "Selector contract" section):
//   T1 founder flag:
//     - useForyouRedesignFlag() also returns true when
//       import.meta.env.DEV && localStorage.getItem('maskin-flag-foryou-redesign') === '1'
//     - DEV guard keeps the override out of production; canary stays
//       founder-only there.
//   T2 header controls:
//     - Cards/List toggle → tab role, tabs named "Cards" / "List"
//     - Sort control      → button named /sort/i
//     - +New dropdown     → button named /new/i (opens a DropdownMenu, not a modal)
//     - Today's Brief     → button named /today.?s brief/i
//   T3 card kinds (attribute on the card root):
//     - data-card-kind="decision"
//     - data-card-kind="sign_off"
//     - data-card-kind="proposed_bet"
//     Decision cards render a shaded footer with two full-width buttons
//     (data-testid="decision-footer" carrying data-stack-layout so the 375
//     stack-vs-side-by-side assertion doesn't rely on measuring pixel widths).
//     Swipe reveal overlays must survive the restructuring on every kind:
//     - data-testid="mark-read-reveal"    (right-swipe on unread)
//     - data-testid="mark-unread-reveal"  (left-swipe on read)
//   T4 Today's Brief panel:
//     - Container: data-testid="todays-brief-panel"
//     - Rendering mode: data-mode="rail" at ≥1024, data-mode="sheet" below

interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentioning_unread_count: number
	latest_event_id: number
	latest_activity_at: string
	object: {
		id: string
		title: string
		type: string
		status: string
		content: string
		workspaceId: string
		metadata?: Record<string, string> | null
	}
}

function buildItem(
	workspaceId: string,
	overrides: Partial<UnreadFixture> & {
		id: string
		title: string
		type: string
		status?: string
		metadata?: Record<string, string> | null
	},
): UnreadFixture {
	const { id, title, type, status, metadata, ...rest } = overrides
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 42,
		latest_activity_at: new Date().toISOString(),
		object: {
			id,
			title,
			type,
			// `bet` has no `in_review` status in the workspace schema, so
			// decision cards ride on tasks with `metadata.decision_type` set.
			// Callers pass an explicit status when the classifier needs one.
			status: status ?? (type === 'task' ? 'in_review' : 'active'),
			content: 'Preview line — leads the card body before any action UI.',
			workspaceId,
			metadata: metadata ?? null,
		},
		...rest,
	}
}

// One card of each kind. T3 classifies by object shape:
//   - task + status=in_review + metadata.decision_type set → decision
//     (needs a call — shaded footer + buttons)
//   - task + status=in_review + no decision_type          → sign_off
//     (light-touch — chip-row)
//   - bet + status=signal                                  → proposed_bet
//     (light-touch — chip-row)
function threeKindFeed(workspaceId: string): UnreadFixture[] {
	return [
		buildItem(workspaceId, {
			id: 'decision-1',
			title: 'Approve the go/no-go for the Q3 canary',
			type: 'task',
			status: 'in_review',
			metadata: { decision_type: 'architecture' },
			mentioning_unread_count: 1,
		}),
		buildItem(workspaceId, {
			id: 'sign-off-1',
			title: 'Sign off on the migration playbook',
			type: 'task',
			status: 'in_review',
		}),
		buildItem(workspaceId, {
			id: 'proposed-bet-1',
			title: 'Proposed bet: staffing lift for the outbound funnel',
			type: 'bet',
			status: 'signal',
			unread_count: 2,
		}),
	]
}

async function mockFeed(page: Page, items: UnreadFixture[]) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
	// Cards fetch thread events on visibility; empty is fine for layout.
	await page.route('**/api/events*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

// The T1 flag gates the redesign on founder actor id in production and on
// this localStorage key when `import.meta.env.DEV` is true. auth.fixture.ts
// mints a random-UUID actor, so the DEV override is the only mechanism that
// puts CI on the redesigned surface.
async function enableRedesignFlag(page: Page) {
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem('maskin-flag-foryou-redesign', '1')
		} catch {
			// Storage not writable in some contexts — nothing else to fall back to.
		}
	})
}

async function gotoForyou(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}`)
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForLoadState('load')
	// SSE holds a long-lived connection so networkidle never fires — brief
	// layout-settle wait after `load`.
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(
		scrollWidth,
		`${label}: page overflows horizontally — scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
	).toBeLessThanOrEqual(innerWidth + 1)
}

async function swipeCard(page: Page, cardIndex: number, direction: 'left' | 'right') {
	const card = page.getByTestId('unread-thread-card').nth(cardIndex)
	const box = await card.boundingBox()
	if (!box) throw new Error(`Card ${cardIndex} has no layout box`)
	const startX = box.x + box.width / 2
	const y = box.y + box.height / 2
	const endX = direction === 'left' ? startX - 150 : startX + 150
	await page.mouse.move(startX, y)
	await page.mouse.down()
	// Multiple intermediate steps — velocity registers and the pointer-move
	// handler unlocks the horizontal axis (locked at ±4px).
	await page.mouse.move(endX, y, { steps: 12 })
	await page.mouse.up()
}

test.describe('For You prototype redesign — layout at 1024', () => {
	test.use({ viewport: VIEWPORTS.tabletLandscape })

	test("sidebar full, feed + Today's Brief rail side-by-side, header controls + all three card kinds render", async ({
		page,
		account,
	}) => {
		await enableRedesignFlag(page)
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		// Sidebar renders full-width at ≥1024 (shadcn Sidebar in expanded state).
		// The primitive exposes data-state="expanded" on its wrapper when open.
		const sidebar = page.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first()
		await expect(sidebar).toBeVisible()
		const sidebarState = await sidebar.getAttribute('data-state')
		expect(sidebarState, 'sidebar must be expanded at 1024').toBe('expanded')

		// Header controls (T2) — Cards/List toggle, sort, +New, Today's Brief.
		await expect(page.getByRole('tab', { name: /cards/i })).toBeVisible()
		await expect(page.getByRole('tab', { name: /list/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /sort/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /^\+?\s*new/i })).toBeVisible()
		const briefTrigger = page.getByRole('button', { name: /today.?s brief/i })
		await expect(briefTrigger).toBeVisible()

		// Open Today's Brief — at ≥1024 it renders as a right-rail beside the feed,
		// not a Sheet overlay.
		await briefTrigger.click()
		const briefPanel = page.getByTestId('todays-brief-panel')
		await expect(briefPanel).toBeVisible()
		await expect(briefPanel).toHaveAttribute('data-mode', 'rail')

		// Feed stays visible next to the rail (the AC's "feed does not disappear"
		// invariant — rules out a modal Sheet swap at desktop).
		await expect(page.getByTestId('unread-thread-card').first()).toBeVisible()

		// One card of each kind renders (T3 attribute contract).
		await expect(page.locator('[data-card-kind="decision"]')).toHaveCount(1)
		await expect(page.locator('[data-card-kind="sign_off"]')).toHaveCount(1)
		await expect(page.locator('[data-card-kind="proposed_bet"]')).toHaveCount(1)

		await assertNoHorizontalOverflow(page, '1024')
	})
})

test.describe('For You prototype redesign — layout at 768', () => {
	test.use({ viewport: VIEWPORTS.tabletPortrait })

	test("sidebar collapses to 56px icon rail, Today's Brief opens as Sheet, header controls reachable", async ({
		page,
		account,
	}) => {
		await enableRedesignFlag(page)
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		// Sidebar collapses to icons at iPad portrait — shadcn drives this via
		// data-state="collapsed" on the wrapper (collapsible="icon" mode).
		const sidebar = page.locator('[data-slot="sidebar"], [data-sidebar="sidebar"]').first()
		await expect(sidebar).toBeVisible()
		const collapsedBox = await sidebar.boundingBox()
		expect(collapsedBox, 'sidebar must have a layout box at 768').not.toBeNull()
		// AC calls for a 56px icon rail — allow a small tolerance for border/padding
		// deltas across primitive versions (48–72px accepts the shadcn default and
		// hand-tuned rails within the AC intent).
		if (collapsedBox) {
			expect(collapsedBox.width).toBeGreaterThanOrEqual(48)
			expect(collapsedBox.width).toBeLessThanOrEqual(72)
		}

		// Header controls reachable — the AC allows wrapping at 768 as long as
		// each control is visible and interactive on touch.
		for (const name of [/cards/i, /list/i]) {
			await expect(page.getByRole('tab', { name })).toBeVisible()
		}
		await expect(page.getByRole('button', { name: /sort/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /^\+?\s*new/i })).toBeVisible()

		const briefTrigger = page.getByRole('button', { name: /today.?s brief/i })
		await expect(briefTrigger).toBeVisible()
		await briefTrigger.click()

		// Below 1024 the panel becomes a Sheet overlay (bottom-anchored on
		// mobile — see apps/web/CLAUDE.md `Dialogs, sheets, popovers`).
		const briefPanel = page.getByTestId('todays-brief-panel')
		await expect(briefPanel).toBeVisible()
		await expect(briefPanel).toHaveAttribute('data-mode', 'sheet')

		await assertNoHorizontalOverflow(page, '768')
	})
})

test.describe('For You prototype redesign — layout at 375', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	test('sidebar hidden, decision buttons stack, header collapses to essentials, no horizontal scroll', async ({
		page,
		account,
	}) => {
		await enableRedesignFlag(page)
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		// Sidebar becomes a Sheet drawer at mobile — closed by default, so no
		// visible sidebar chrome should be occupying viewport width. The trigger
		// (hamburger) lives in the header at `md:hidden` — that's the touchable
		// entry point, and the AC's "sidebar hidden" invariant.
		const sidebarSheet = page.locator('[data-slot="sidebar"][data-state="open"]')
		await expect(sidebarSheet).toHaveCount(0)

		// The +New and Today's Brief triggers remain reachable at 375 — either
		// visible on the row or collapsed into an overflow/icon control per
		// the AC's "essential set (icon-only where necessary)" allowance.
		// getByRole picks up both label and aria-label so icon-only buttons
		// with `aria-label="New"` still match.
		await expect(page.getByRole('button', { name: /^\+?\s*new/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /today.?s brief/i })).toBeVisible()

		// Decision buttons stack vertically at 375. T3's Decision card exposes
		// its footer with `data-testid="decision-footer"` and a
		// `data-stack-layout` attribute so this doesn't have to measure widths.
		const decisionFooter = page
			.locator('[data-card-kind="decision"] [data-testid="decision-footer"]')
			.first()
		await expect(decisionFooter).toBeVisible()
		const stackLayout = await decisionFooter.getAttribute('data-stack-layout')
		expect(stackLayout, 'Decision card footer must stack its buttons vertically at 375').toBe(
			'stacked',
		)

		// No page-level horizontal overflow at 375 — the frontend rule.
		await assertNoHorizontalOverflow(page, '375')
	})
})

test.describe('For You prototype redesign — swipe regression across card kinds', () => {
	// One focused pass at 375 (where the swipe gesture is the primary
	// interaction). Right-swipe on unread → mark-read green reveal +
	// /api/subscriptions/read POST after the 4.5s Undo window. Left-swipe on a
	// read card → mark-unread blue reveal + /api/subscriptions/unread POST.
	test.use({ viewport: VIEWPORTS.mobile })

	async function captureRead(page: Page): Promise<{ readonly calls: unknown[] }> {
		const calls: unknown[] = []
		await page.route('**/api/subscriptions/read', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			try {
				calls.push(route.request().postDataJSON())
			} catch {
				calls.push(null)
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ updated: true }),
			})
		})
		return { calls }
	}

	async function captureUnread(page: Page): Promise<{ readonly calls: unknown[] }> {
		const calls: unknown[] = []
		await page.route('**/api/subscriptions/unread', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			try {
				calls.push(route.request().postDataJSON())
			} catch {
				calls.push(null)
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ updated: true }),
			})
		})
		return { calls }
	}

	test('right-swipe on unread card reveals mark-read affordance and commits', async ({
		page,
		account,
	}) => {
		const { calls: readCalls } = await captureRead(page)
		await enableRedesignFlag(page)
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards).toHaveCount(3)

		await swipeCard(page, 0, 'right')

		// Green mark-read reveal + toast with Undo appear during the 4.5s window.
		await expect(page.getByTestId('mark-read-reveal').first()).toBeVisible()
		await expect(page.getByText(/Marked as read/i)).toBeVisible()
		await expect(page.getByRole('button', { name: /^undo$/i })).toBeVisible()

		// Commit fires after the Undo window elapses.
		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)
	})

	test('left-swipe on a read card reveals mark-unread affordance and commits', async ({
		page,
		account,
	}) => {
		const { calls: unreadCalls } = await captureUnread(page)
		await enableRedesignFlag(page)
		// One read card in the mix so the reverse-swipe has a target — mirrors
		// the mixed-feed pattern the existing foryou-swipe-mark-unread spec uses.
		const items = threeKindFeed(account.workspaceId)
		items.push(
			buildItem(account.workspaceId, {
				id: 'decision-read',
				title: 'Already-read decision',
				type: 'task',
				status: 'in_review',
				metadata: { decision_type: 'architecture' },
				unread_count: 0,
				latest_event_id: 99,
			}),
		)
		await mockFeed(page, items)
		await gotoForyou(page, account.workspaceId)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards).toHaveCount(4)

		// Read card is the last one in the mocked feed (unread_count === 0).
		await swipeCard(page, 3, 'left')

		await expect(page.getByTestId('mark-unread-reveal').first()).toBeVisible()
		await expect(page.getByText(/Marked as unread/i)).toBeVisible()
		await expect(page.getByRole('button', { name: /^undo$/i })).toBeVisible()

		await page.waitForTimeout(4800)
		expect(unreadCalls.length).toBeGreaterThanOrEqual(1)
	})
})
