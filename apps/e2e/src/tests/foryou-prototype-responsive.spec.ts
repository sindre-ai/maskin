import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// T2-T6 of bet foryou-prototype-redesign (single-card swipeable queue
// rebuild): responsive layout + interaction regression at 375/768/1024 for
// the new ForYouHeader (Display popover, type-filter chips) and
// ForYouCardQueue (one visible card, decision->receipt->reverse, swipe/
// button-driven commit, empty state).
//
// Unread feed is mocked so card kinds land deterministically, driven off
// `object.type`/`status`/`metadata.decision_type` per `classifyCardKind` in
// `lib/foryou-card-kind.ts`: task+in_review+decision_type -> decision,
// task+in_review (no decision_type) -> sign_off, bet+signal/proposed/
// define/clustered -> proposed_bet, everything else (including all insight
// items) -> thread. Bets have no `in_review` status in the workspace
// schema, so `decision` never keys off `bet.status`.
//
// Selector contract this spec relies on:
// - ForYouHeaderIdentity: projected into the global header's sticky-identity
//   slot (data-testid="foryou-header-identity", rendered twice — a desktop
//   and a mobile copy — so scope to `.first()`), "For You" + "{n} unread".
// - ForYouHeaderActions: projected into the global header's actions slot —
//   "Today's brief" / "New" buttons (aria-label).
// - ForYouHeader: type-filter chips as named buttons ("All (n)",
//   "Mentions (n)", "{Type} (n)"), "Display options" button opening a
//   Cards/List Tabs (role=tab) + Sort RadioGroup (role=radio).
// - ForYouQueueCard: data-testid="foryou-queue-card" with a
//   data-card-kind attribute, data-testid="decision-block" /
//   "decision-receipt", data-testid="mark-read-reveal" (swipe overlay).
// - ForYouCardQueue: "Keep unread" / "Mark as read" fixed-bar buttons, an
//   "{n} item(s) left" counter (hidden below md), EmptyState "You're caught up".

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
	overrides: Partial<Omit<UnreadFixture, 'object'>> & {
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
			content: 'Preview line leads the card body before the action UI.',
			workspaceId,
			metadata: metadata ?? null,
		},
		...rest,
	}
}

// One card per kind — decision sorts first (it's the only one mentioning
// the viewer, and default sort is "priority").
//   - task + status=in_review + metadata.decision_type set → decision
//   - task + status=in_review + no decision_type          → sign_off
//   - bet + status=signal                                  → proposed_bet
function threeKindFeed(workspaceId: string): UnreadFixture[] {
	return [
		buildItem(workspaceId, {
			id: 'decision-1',
			title: 'Approve go/no-go for Q3 canary',
			type: 'task',
			status: 'in_review',
			metadata: { decision_type: 'architecture' },
			mentioning_unread_count: 1,
		}),
		buildItem(workspaceId, {
			id: 'sign-off-1',
			title: 'Sign off on migration playbook',
			type: 'task',
			status: 'in_review',
		}),
		buildItem(workspaceId, {
			id: 'proposed-bet-1',
			title: 'Proposed bet: expand canary to EU region',
			type: 'bet',
			status: 'signal',
			latest_event_id: 43,
		}),
	]
}

// Two plain "thread"-kind items for the swipe/skip/commit regression — kept
// independent of the decision defer-then-commit state machine.
function plainFeed(workspaceId: string): UnreadFixture[] {
	return [
		buildItem(workspaceId, { id: 'thread-1', title: 'Renewal terms need a read', type: 'insight' }),
		buildItem(workspaceId, {
			id: 'thread-2',
			title: 'Follow-up from customer call',
			type: 'insight',
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
	await page.route('**/api/events*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

async function gotoForyou(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}`)
}

// The global layout header (layout/header.tsx) now also has its own "New"
// menu, so `getByRole('button', { name: /^new$/i })` alone matches two
// buttons on this page. Scope to ForYouHeader's own <header> via its unique
// "Today's brief" button to disambiguate.
function foryouHeader(page: Page) {
	return page
		.locator('header')
		.filter({ has: page.getByRole('button', { name: /today.?s brief/i }) })
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForLoadState('load')
	// SSE holds a long-lived connection so networkidle never fires — a brief
	// layout-settle wait after `load` instead.
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(
		scrollWidth,
		`${label}: page overflows horizontally — scrollWidth=${scrollWidth} innerWidth=${innerWidth}`,
	).toBeLessThanOrEqual(innerWidth + 1)
}

async function swipeCurrentCard(page: Page, direction: 'left' | 'right') {
	const card = page.getByTestId('foryou-queue-card')
	const box = await card.boundingBox()
	if (!box) throw new Error('Current queue card has no layout box')
	const startX = box.x + box.width / 2
	const startY = box.y + 80 // upper card body — clear of footer buttons
	const endX = direction === 'right' ? startX + 150 : startX - 150
	await page.mouse.move(startX, startY)
	await page.mouse.down()
	await page.mouse.move(endX, startY, { steps: 12 })
	await page.mouse.up()
}

async function assertDecisionButtonsSideBySide(page: Page, expected: boolean, label: string) {
	const approve = page.getByRole('button', { name: 'Approve' })
	const sendBack = page.getByRole('button', { name: 'Send back' })
	const [approveBox, sendBackBox] = await Promise.all([
		approve.boundingBox(),
		sendBack.boundingBox(),
	])
	expect(approveBox, `${label}: Approve button has no layout box`).not.toBeNull()
	expect(sendBackBox, `${label}: Send back button has no layout box`).not.toBeNull()
	if (!approveBox || !sendBackBox) return
	const yDelta = Math.abs(approveBox.y - sendBackBox.y)
	if (expected) {
		expect(yDelta, `${label}: decision buttons must sit side-by-side`).toBeLessThan(4)
	} else {
		expect(yDelta, `${label}: decision buttons must stack vertically`).toBeGreaterThan(8)
	}
}

test.describe('For You prototype redesign — layout at 1024', () => {
	test.use({ viewport: VIEWPORTS.tabletLandscape })

	test('header controls, Display popover, and decision buttons render side-by-side', async ({
		page,
		account,
	}) => {
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		const identity = page.getByTestId('foryou-header-identity').first()
		await expect(identity).toBeVisible()
		await expect(identity).toContainText('For You')
		await expect(identity).toContainText('3 unread')

		await expect(page.getByRole('button', { name: /^All/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /^Mentions/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /^Bet/ })).toBeVisible()
		await expect(page.getByRole('button', { name: /^Task/ })).toBeVisible()

		await expect(page.getByRole('button', { name: /today.?s brief/i })).toBeVisible()
		await expect(foryouHeader(page).getByRole('button', { name: /^new$/i })).toBeVisible()

		// The global header's generic Create/Chat icon buttons are dropped on
		// the For You page — ForYouHeader's title, "Today's brief", and "New"
		// already cover the same actions.
		await expect(page.getByRole('button', { name: /create new/i })).toHaveCount(0)
		await expect(page.getByRole('button', { name: /open chat/i })).toHaveCount(0)

		const displayTrigger = page.getByRole('button', { name: /display options/i })
		await displayTrigger.click()
		await expect(page.getByRole('tab', { name: /cards/i })).toBeVisible()
		await expect(page.getByRole('tab', { name: /list/i })).toBeVisible()
		await expect(page.getByRole('radio', { name: /priority/i })).toBeVisible()
		await expect(page.getByRole('radio', { name: /latest activity/i })).toBeVisible()
		await page.keyboard.press('Escape')

		// One card visible at a time — priority sort puts the mentioned
		// decision card first.
		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toHaveCount(1)
		await expect(card).toHaveAttribute('data-card-kind', 'decision')
		await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
		await assertDecisionButtonsSideBySide(page, true, '1024')

		await expect(page.getByRole('button', { name: 'Keep unread' })).toBeVisible()
		await expect(page.getByRole('button', { name: 'Mark as read' })).toBeVisible()
		await expect(page.getByText('3 items left')).toBeVisible()

		await assertNoHorizontalOverflow(page, '1024')
	})
})

test.describe('For You prototype redesign — layout at 768', () => {
	test.use({ viewport: VIEWPORTS.tabletPortrait })

	test('header controls stay reachable and decision buttons stay side-by-side', async ({
		page,
		account,
	}) => {
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		await expect(page.getByRole('button', { name: /today.?s brief/i })).toBeVisible()
		await expect(foryouHeader(page).getByRole('button', { name: /^new$/i })).toBeVisible()
		await expect(page.getByRole('button', { name: /display options/i })).toBeVisible()

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toHaveAttribute('data-card-kind', 'decision')
		await assertDecisionButtonsSideBySide(page, true, '768')

		await expect(page.getByText('3 items left')).toBeVisible()
		await assertNoHorizontalOverflow(page, '768')
	})
})

test.describe('For You prototype redesign — layout at 375', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	test('decision buttons stack, Display popover still opens, no horizontal scroll', async ({
		page,
		account,
	}) => {
		await mockFeed(page, threeKindFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		// Icon-only at 375 — accessible name still comes from aria-label.
		await expect(page.getByRole('button', { name: /today.?s brief/i })).toBeVisible()
		await expect(foryouHeader(page).getByRole('button', { name: /^new$/i })).toBeVisible()

		const displayTrigger = page.getByRole('button', { name: /display options/i })
		await displayTrigger.click()
		await expect(page.getByRole('tab', { name: /cards/i })).toBeVisible()
		await page.keyboard.press('Escape')

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toHaveAttribute('data-card-kind', 'decision')
		await assertDecisionButtonsSideBySide(page, false, '375')

		// "N items left" is a desktop-only affordance (`hidden md:inline`).
		await expect(page.getByText(/items left/)).toBeHidden()

		await assertNoHorizontalOverflow(page, '375')
	})
})

test.describe('For You prototype redesign — decision → receipt → reverse', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	test('choosing a decision defers the comment behind a reversible receipt', async ({
		page,
		account,
	}) => {
		const postedComments: unknown[] = []
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			postedComments.push(route.request().postDataJSON())
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 1 }),
			})
		})
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'decision-1',
				title: 'Approve go/no-go for Q3 canary',
				type: 'task',
				status: 'in_review',
				metadata: { decision_type: 'architecture' },
			}),
		])
		await gotoForyou(page, account.workspaceId)

		await page.getByRole('button', { name: 'Approve' }).click()

		const receipt = page.getByTestId('decision-receipt')
		await expect(receipt).toBeVisible()
		await expect(receipt).toContainText(/you chose approve/i)
		await expect(receipt).toContainText(/reversible for \d+s/i)

		await receipt.getByRole('button', { name: 'Reverse this' }).click()
		await expect(page.getByTestId('decision-block')).toBeVisible()
		await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()

		// Nothing was posted — the reverse window never elapsed.
		await page.waitForTimeout(6500)
		expect(postedComments).toHaveLength(0)
	})
})

test.describe('For You prototype redesign — swipe & button commit regression', () => {
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

	test('right-swipe reveals mark-read and advances the queue, committing after the undo window', async ({
		page,
		account,
	}) => {
		const { calls: readCalls } = await captureRead(page)
		await mockFeed(page, plainFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText(
			'Renewal terms need a read',
		)

		await swipeCurrentCard(page, 'right')
		await expect(page.getByTestId('mark-read-reveal').first()).toBeVisible()

		// The queue advances optimistically as soon as the exit transition
		// ends — well before the 4.5s undo window elapses. The just-committed
		// card stays mounted (hidden) until its deferred mutation lands, so
		// the locator must be scoped to the currently-visible card only.
		await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText(
			'Follow-up from customer call',
		)
		expect(readCalls).toHaveLength(0)

		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)
	})

	test('"Keep unread" skips without any mutation and advances the queue', async ({
		page,
		account,
	}) => {
		const { calls: readCalls } = await captureRead(page)
		await mockFeed(page, plainFeed(account.workspaceId))
		await gotoForyou(page, account.workspaceId)

		await page.getByRole('button', { name: 'Keep unread' }).click()
		await expect(page.getByTestId('foryou-queue-card')).toContainText(
			'Follow-up from customer call',
		)

		await page.waitForTimeout(1000)
		expect(readCalls).toHaveLength(0)
	})

	test('"Mark as read" commits through the same undo path as a swipe and empties the queue', async ({
		page,
		account,
	}) => {
		const { calls: readCalls } = await captureRead(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, { id: 'thread-1', title: 'Only item left', type: 'insight' }),
		])
		await gotoForyou(page, account.workspaceId)

		await page.getByRole('button', { name: 'Mark as read' }).click()
		await expect(page.getByText("You're caught up")).toBeVisible()

		await expect(page.getByRole('link', { name: "Today's brief" })).toBeVisible()
		await expect(page.getByRole('link', { name: /review loops/i })).toBeVisible()

		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)
	})
})

// Regression coverage for five card/composer fixes: summary hide/show toggle,
// removal of the redundant plain-text object type under the title, the card
// stretching to fill its container instead of leaving empty space below it,
// the shortened single-line composer placeholder on mobile, and the
// composer textarea being focusable with a single tap (the fix excludes
// form controls from the swipe-to-mark-read pointer-capture handler).
async function assertCardFillsAvailableHeight(page: Page, label: string) {
	const cardBox = await page.getByTestId('foryou-queue-card').boundingBox()
	if (!cardBox) throw new Error(`${label}: card has no layout box`)
	const actionBox = await page.getByRole('button', { name: 'Mark as read' }).boundingBox()
	if (!actionBox) throw new Error(`${label}: action bar has no layout box`)
	const gap = actionBox.y - (cardBox.y + cardBox.height)
	// Threshold tolerates the pre-existing max-h-[min(680px,calc(100vh-220px))]
	// chrome estimate on the card (not exact at every viewport) while still
	// catching a regression back to shrink-to-content sizing, which leaves
	// hundreds of px of empty space rather than tens.
	expect(
		gap,
		`${label}: card leaves ${gap}px of empty space above the action bar instead of stretching to fill the container`,
	).toBeLessThan(150)
}

test.describe('For You prototype redesign — card fills container height', () => {
	for (const [label, viewport] of [
		['375', VIEWPORTS.mobile],
		['768', VIEWPORTS.tabletPortrait],
		['1024', VIEWPORTS.tabletLandscape],
	] as const) {
		test(`card stretches to the bottom action bar with no empty space at ${label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize(viewport)
			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'thread-1',
					title: 'Renewal terms need a read',
					type: 'insight',
				}),
			])
			await gotoForyou(page, account.workspaceId)

			await expect(page.getByTestId('foryou-queue-card')).toBeVisible()
			await assertCardFillsAvailableHeight(page, label)
		})
	}
})

test.describe('For You prototype redesign — summary toggle', () => {
	test.use({ viewport: VIEWPORTS.tabletLandscape })

	test('the summary strip truncates by default and expands/collapses via the toggle', async ({
		page,
		account,
	}) => {
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const summary = page.locator('p', {
			hasText: 'Preview line leads the card body before the action UI.',
		})
		await expect(summary).toHaveClass(/line-clamp-3/)

		await page.getByRole('button', { name: 'Show full' }).click()
		await expect(summary).not.toHaveClass(/line-clamp-3/)

		await page.getByRole('button', { name: 'Hide' }).click()
		await expect(summary).toHaveClass(/line-clamp-3/)
	})
})

test.describe('For You prototype redesign — metadata row', () => {
	test.use({ viewport: VIEWPORTS.tabletLandscape })

	test('does not render the object type a second time as a plain-text label under the title', async ({
		page,
		account,
	}) => {
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toBeVisible()
		// The TypeBadge icon badge is the only place "insight" should render —
		// no redundant plain-text span duplicating it beneath the title.
		await expect(card.getByText('insight', { exact: true })).toHaveCount(1)
	})
})

test.describe('For You prototype redesign — composer', () => {
	async function gotoWithSingleThread(page: Page, workspaceId: string) {
		await mockFeed(page, [
			buildItem(workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, workspaceId)
	}

	test('placeholder is a single short line at 375px', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await gotoWithSingleThread(page, account.workspaceId)

		await expect(page.getByPlaceholder('Write a comment...')).toBeVisible()
		await expect(page.getByPlaceholder('Write a comment... Use @ to mention an agent')).toHaveCount(
			0,
		)
	})

	test('placeholder includes the full hint at 1024px', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		await gotoWithSingleThread(page, account.workspaceId)

		await expect(
			page.getByPlaceholder('Write a comment... Use @ to mention an agent'),
		).toBeVisible()
	})

	test('a single tap focuses the composer textarea', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await gotoWithSingleThread(page, account.workspaceId)

		const textarea = page.getByPlaceholder('Write a comment...')
		await textarea.click()
		await expect(textarea).toBeFocused()
	})
})
