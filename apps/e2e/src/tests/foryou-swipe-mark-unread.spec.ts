import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// T3 of bet `foryou-swipe-unread`: reverse-swipe (mark-unread) on read For You
// cards at the 375px viewport. Locks the mobile-side interaction contract:
//
// - swipe-left on a read card past 80px reveals the Blue Envelope affordance,
//   fires a "Marked as unread" toast with Undo, and (after the 4.5s window)
//   POSTs to /api/subscriptions/unread.
// - the mark-read side of the gesture on an unread card is unchanged
//   (right-swipe → green Mark-read reveal → POST /api/subscriptions/read).
// - wrong-direction swipe on a read card produces no reveal and no request.
//
// The unread feed is mocked at the /api/subscriptions/unread boundary so we
// can stage one read card alongside one unread card in the same stream.

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
	}
}

function buildItem(
	workspaceId: string,
	n: number,
	overrides: Partial<UnreadFixture> = {},
): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: `bet-${n}`,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10 + n,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: `bet-${n}`,
			title: `For You bet ${n}`,
			type: 'bet',
			status: 'active',
			content: '',
			workspaceId,
		},
		...overrides,
	}
}

async function mockMixedFeed(page: Page, workspaceId: string) {
	// GET /api/subscriptions/unread → one unread card + one recently-read card
	// (unread_count === 0). Both are returned regardless of the
	// `include_recently_read` query so the assertions land whether the surface
	// asks for the mixed feed or the default.
	const items = [
		buildItem(workspaceId, 1, { unread_count: 2, mentioning_unread_count: 0 }),
		buildItem(workspaceId, 2, {
			unread_count: 0,
			mentioning_unread_count: 0,
			latest_event_id: 22,
		}),
	]
	await page.route('**/api/subscriptions/unread*', async (route) => {
		// Only handle GET — leave POSTs to the dedicated capture below.
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

async function captureMarkUnread(page: Page): Promise<{ readonly calls: unknown[] }> {
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

async function captureMarkRead(page: Page): Promise<{ readonly calls: unknown[] }> {
	const calls: unknown[] = []
	await page.route('**/api/subscriptions/read', async (route) => {
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

async function swipeCard(page: Page, cardIndex: number, direction: 'left' | 'right') {
	const card = page.getByTestId('unread-thread-card').nth(cardIndex)
	const box = await card.boundingBox()
	if (!box) throw new Error(`Card ${cardIndex} has no layout box`)

	const startX = box.x + box.width / 2
	const y = box.y + box.height / 2
	const endX = direction === 'left' ? startX - 150 : startX + 150

	await page.mouse.move(startX, y)
	await page.mouse.down()
	// Multiple intermediate steps → velocity registers and the pointer-move
	// handler unlocks the horizontal axis (locked at ±4px).
	await page.mouse.move(endX, y, { steps: 12 })
	await page.mouse.up()
}

test.describe('For You — reverse-swipe (mark-unread) at 375px', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	test('swipe-left on a read card reveals Blue Envelope, toasts, and commits after 4.5s', async ({
		page,
		account,
	}) => {
		const { calls: unreadCalls } = await captureMarkUnread(page)
		const { calls: readCalls } = await captureMarkRead(page)
		await mockMixedFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards).toHaveCount(2)

		// The read card is item index 1 in the mocked feed (unread_count === 0).
		await swipeCard(page, 1, 'left')

		// Toast confirms mark-unread with an Undo affordance.
		await expect(page.getByText(/Marked as unread/i)).toBeVisible()
		await expect(page.getByRole('button', { name: /^undo$/i })).toBeVisible()

		// No commit until the 4.5s Undo window elapses.
		expect(unreadCalls).toHaveLength(0)

		// Advance past the Undo window; the mark-unread POST fires.
		await page.waitForTimeout(4800)
		expect(unreadCalls.length).toBeGreaterThanOrEqual(1)
		const body = unreadCalls[0] as { entity_type: string; entity_id: string }
		expect(body.entity_type).toBe('object')
		expect(body.entity_id).toBe('bet-2')

		// The mark-read endpoint must not have been touched by the reverse gesture.
		expect(readCalls).toHaveLength(0)
	})

	test('swipe-right on an unread card still fires the green Mark-read reveal + commit', async ({
		page,
		account,
	}) => {
		const { calls: unreadCalls } = await captureMarkUnread(page)
		const { calls: readCalls } = await captureMarkRead(page)
		await mockMixedFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards).toHaveCount(2)

		// The unread card is item index 0 in the mocked feed.
		await swipeCard(page, 0, 'right')

		await expect(page.getByText(/Marked as read/i)).toBeVisible()
		await expect(page.getByRole('button', { name: /^undo$/i })).toBeVisible()

		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)
		expect(unreadCalls).toHaveLength(0)
	})

	test('wrong-direction swipe on a read card bounces back with no reveal and no request', async ({
		page,
		account,
	}) => {
		const { calls: unreadCalls } = await captureMarkUnread(page)
		const { calls: readCalls } = await captureMarkRead(page)
		await mockMixedFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards).toHaveCount(2)

		// Swipe RIGHT on the read card (wrong direction — read cards only accept
		// left-swipe). No toast, no request should ever fire.
		await swipeCard(page, 1, 'right')

		await page.waitForTimeout(500)
		await expect(page.getByText(/Marked as unread/i)).toHaveCount(0)
		await expect(page.getByText(/Marked as read/i)).toHaveCount(0)

		await page.waitForTimeout(4800)
		expect(unreadCalls).toHaveLength(0)
		expect(readCalls).toHaveLength(0)
	})

	test('desktop drag on the mark-read side of an unread card is unchanged at 1024px', async ({
		page,
		account,
	}) => {
		// Desktop parity guard: the bet's AC keeps existing mark-read behaviour
		// on non-mobile viewports. Reuse the same right-swipe → mark-read commit
		// path with the pointer at iPad-landscape width.
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		const { calls: readCalls } = await captureMarkRead(page)
		await mockMixedFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const cards = page.getByTestId('unread-thread-card')
		await expect(cards.first()).toBeVisible()

		await swipeCard(page, 0, 'right')
		await expect(page.getByText(/Marked as read/i)).toBeVisible()
		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)
	})
})
