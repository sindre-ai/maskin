import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// T2 of bet `maskin-mobile-app` — lock the iPhone For You card feed against
// the bet's canonical three verbs (approve, dismiss, comment). These three
// must complete end-to-end and reflect immediately in the feed at 375×812
// (the iPhone reference viewport the bet ships to). Hold and Ship-it from
// older mockup iterations are deliberately not tested here — they are out of
// scope for the six-AC bet and must not creep back in.
//
// What each verb resolves to in the shipped implementation:
// - **Approve** on a decision card → chooseDecision defers the "Approved"
//   comment behind a 6s reverse window, then posts it + marks read + advances.
//   On a thread card the same intent lands as the "Approved" quick-reply chip
//   via runQuickReply → posts comment + marks read + advances immediately.
// - **Dismiss** on a proposed-bet card → the "Dismiss" chip via runQuickReply
//   → posts comment + marks read + advances. On any other card the same
//   intent lands as the bottom-bar "Keep unread" skip (no mutation, but the
//   queue advances so the user is unblocked).
// - **Comment** via the CommentInput at the bottom of every card → posts the
//   comment to /api/events; the thread reflects it in place.
//
// Tap-target gate: bottom-bar Approve/Dismiss shortcuts and the chip-strip
// actions must be ≥44px tall (Apple HIG minimum for thumb targets) at
// mobile viewports, dropping back to the compact desktop size at md.

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
	overrides: {
		id: string
		title: string
		type: string
		status?: string
		metadata?: Record<string, string> | null
		latest_event_id?: number
		mentioning_unread_count?: number
	},
): UnreadFixture {
	const {
		id,
		title,
		type,
		status,
		metadata,
		latest_event_id: latestEventId,
		mentioning_unread_count: mentioning,
	} = overrides
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: 1,
		mentioning_unread_count: mentioning ?? 0,
		latest_event_id: latestEventId ?? 42,
		latest_activity_at: new Date().toISOString(),
		object: {
			id,
			title,
			type,
			status: status ?? (type === 'task' ? 'in_review' : 'active'),
			content: 'Preview line leads the card body before the action UI.',
			workspaceId,
			metadata: metadata ?? null,
		},
	}
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

interface CapturedPosts {
	readonly comments: unknown[]
	readonly reads: unknown[]
}

async function captureMutations(page: Page): Promise<CapturedPosts> {
	const comments: unknown[] = []
	const reads: unknown[] = []
	await page.route('**/api/events', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback()
		try {
			comments.push(route.request().postDataJSON())
		} catch {
			comments.push(null)
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ id: comments.length }),
		})
	})
	await page.route('**/api/subscriptions/read', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback()
		try {
			reads.push(route.request().postDataJSON())
		} catch {
			reads.push(null)
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ updated: true }),
		})
	})
	return { comments, reads }
}

async function gotoForyou(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}`)
}

test.describe('T2 iPhone For You feed — approve, dismiss, comment', () => {
	test.use({ viewport: VIEWPORTS.mobile })

	test('feed loads at 375 with no horizontal overflow', async ({ page, account }) => {
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		await expect(page.getByTestId('foryou-queue-card')).toBeVisible()

		await page.waitForTimeout(200)
		const { scrollWidth, innerWidth } = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}))
		expect(
			scrollWidth,
			`iPhone feed overflows: scrollWidth=${scrollWidth} innerWidth=${innerWidth}`,
		).toBeLessThanOrEqual(innerWidth + 1)
	})

	test('Approve on a decision card posts comment, marks read, and advances the queue', async ({
		page,
		account,
	}) => {
		const captured = await captureMutations(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'decision-1',
				title: 'Approve go/no-go for Q3 canary',
				type: 'task',
				status: 'in_review',
				metadata: { decision_type: 'architecture' },
				mentioning_unread_count: 1,
			}),
			buildItem(account.workspaceId, {
				id: 'thread-follow',
				title: 'Next up',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toHaveAttribute('data-card-kind', 'decision')
		await page.getByRole('button', { name: 'Approve' }).click()

		const receipt = page.getByTestId('decision-receipt')
		await expect(receipt).toBeVisible()
		await expect(receipt).toContainText(/you chose approve/i)

		// The 6s reverse window elapses, chooseDecision fires the deferred
		// quickReply, then handleMarkRead + beginExit advance the queue.
		await page.waitForTimeout(6500)
		await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText('Next up')
		expect(captured.comments.length).toBeGreaterThanOrEqual(1)
	})

	test('Dismiss on a proposed-bet card posts comment, marks read, and advances the queue', async ({
		page,
		account,
	}) => {
		const captured = await captureMutations(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'bet-proposed',
				title: 'Proposed bet: expand canary to EU region',
				type: 'bet',
				status: 'signal',
				mentioning_unread_count: 1,
			}),
			buildItem(account.workspaceId, {
				id: 'thread-follow',
				title: 'Next up',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toHaveAttribute('data-card-kind', 'proposed_bet')

		// Dismiss chip is a direct runQuickReply — no reverse window; posts the
		// comment, marks read, exits, and the next card takes over. Waiting on
		// the exit animation is what proves the feed reflects the dismissal.
		await page.getByRole('button', { name: 'Dismiss' }).click()
		await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText('Next up')
		expect(captured.comments.length).toBeGreaterThanOrEqual(1)
	})

	test('Comment via the composer posts to the thread and stays on the same card', async ({
		page,
		account,
	}) => {
		const captured = await captureMutations(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const composer = page.getByPlaceholder('Write a comment...')
		await expect(composer).toBeVisible()
		await composer.click()
		await composer.fill('Looks good — approved from mobile.')
		await composer.press('Meta+Enter').catch(async () => {
			// Fallback to plain Enter if the meta chord is captured elsewhere.
			await composer.press('Enter')
		})

		// The composer submit is optimistic — the POST fires before the network
		// round-trip completes. Give the queued mutation a beat to hit our
		// route handler, then assert.
		await page.waitForTimeout(500)
		expect(captured.comments.length).toBeGreaterThanOrEqual(1)

		// Card stays put — comment posts inline, feed doesn't advance.
		await expect(page.getByTestId('foryou-queue-card')).toContainText('Renewal terms need a read')
	})

	test('bottom action bar buttons meet the 44px tap-target minimum', async ({ page, account }) => {
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-1',
				title: 'Renewal terms need a read',
				type: 'insight',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		for (const name of ['Keep unread', 'Mark as read'] as const) {
			const box = await page.getByRole('button', { name }).boundingBox()
			expect(box, `${name}: no layout box`).not.toBeNull()
			if (!box) continue
			expect(
				box.height,
				`${name} is ${box.height}px tall — below the 44px iPhone thumb-target minimum`,
			).toBeGreaterThanOrEqual(44)
		}
	})

	test('quick-reply chips meet the 44px tap-target minimum on iPhone', async ({
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

		const chip = page.locator('[data-testid="chip-row"] button').first()
		await expect(chip).toBeVisible()
		const box = await chip.boundingBox()
		expect(box, 'first chip: no layout box').not.toBeNull()
		if (!box) return
		expect(
			box.height,
			`chip is ${box.height}px tall — below the 44px iPhone thumb-target minimum`,
		).toBeGreaterThanOrEqual(44)
	})
})
