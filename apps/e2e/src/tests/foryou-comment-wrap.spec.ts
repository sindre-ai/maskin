import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Bug bet: the comment field on the For You unread thread cards used to scroll
// horizontally on long text instead of wrapping and growing vertically. The fix
// lives in apps/web/src/components/activity/comment-input.tsx — min-w-0 on the
// flex content wrapper, plus wrap="soft" + break-words on the textarea so its
// scrollHeight reflects the wrapped layout the resize effect reads.
//
// The reply UX has since moved off the card itself: clicking a card's Reply
// button activates it, mounting a CommentInput inside PersistentReplyBar
// (fixed to the viewport bottom) rather than inline in the card footer. This
// spec activates a card first, then drives a long unbroken token (the worst
// case — neither soft-wrap nor word-break helps unless break-words is on)
// into that persistent input and asserts: (a) the textarea grows taller than
// its one-line minimum and (b) the page never produces a horizontal scrollbar.

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
		workspaceId: string
	}
}

function buildItem(workspaceId: string): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: 'bet-foryou-comment-wrap',
		unread_count: 0,
		mentioning_unread_count: 0,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'bet-foryou-comment-wrap',
			title: 'Existing bet under test',
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockUnreadThread(page: Page, workspaceId: string) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [buildItem(workspaceId)] }),
		})
	})
	// The card renders empty for the activity body until it has events; that's
	// fine — the comment input lives in the persistent reply bar regardless.
	await page.route('**/api/events*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

const COMMENT_PLACEHOLDER = 'Write a comment... Use @ to mention an agent'
const LONG_UNBROKEN = 'a'.repeat(200)

test.describe('For You comment field — wraps and grows, no horizontal scroll', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`wraps long text and grows vertically at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockUnreadThread(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('unread-thread-card').first()
			await expect(card).toBeVisible()

			// Activate the card so PersistentReplyBar mounts its CommentInput at
			// the bottom of the viewport — the input no longer lives in the card.
			await card.getByRole('button', { name: 'Reply' }).click()

			const input = page.getByPlaceholder(COMMENT_PLACEHOLDER)
			await expect(input).toBeVisible()

			const initialBox = await input.boundingBox()
			if (!initialBox) throw new Error('comment input has no layout box at rest')

			await input.fill(LONG_UNBROKEN)

			const grownBox = await input.boundingBox()
			if (!grownBox) throw new Error('comment input has no layout box after typing')

			// The textarea must grow vertically once content exceeds one line —
			// MAX_INPUT_HEIGHT_PX caps it at 134px, so we assert it's grown beyond
			// the resting one-line height (~32px) without overshooting the cap.
			expect(
				grownBox.height,
				`textarea must grow taller than the resting one-line height at ${viewport.label}`,
			).toBeGreaterThan(initialBox.height)
			expect(
				grownBox.height,
				`textarea must not exceed MAX_INPUT_HEIGHT_PX at ${viewport.label}`,
			).toBeLessThanOrEqual(134)

			// No horizontal page scroll — the failure mode the user reported.
			const horizScroll = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(horizScroll, `document must not horizontally scroll at ${viewport.label}`).toBe(false)

			// And the input must still fit inside the viewport width.
			expect(grownBox.x + grownBox.width).toBeLessThanOrEqual(viewport.width)
		})
	}
})
