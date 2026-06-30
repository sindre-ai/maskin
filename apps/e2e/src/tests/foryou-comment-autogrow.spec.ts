import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

// Regression: the For You page comment input (CommentInput inside
// UnreadThreadCard) used to scroll horizontally on long text instead of
// wrapping and growing taller. Typing the long string below must produce a
// wrapped, taller textarea with no horizontal scroll.

interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentions_you: boolean
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
		entity_id: 'bet-autogrow-1',
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 42,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'bet-autogrow-1',
			title: 'A bet to comment on',
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockBackend(page: Page, workspaceId: string) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [buildItem(workspaceId)] }),
		})
	})
	await page.route('**/api/events/history*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					id: 42,
					workspaceId,
					actorId: 'someone-else',
					action: 'commented',
					entityType: 'bet',
					entityId: 'bet-autogrow-1',
					data: { content: 'Existing comment' },
					createdAt: new Date().toISOString(),
				},
			]),
		})
	})
}

test.describe('For You comment input auto-grow', () => {
	test('wraps long text and grows vertically without horizontal scroll', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await mockBackend(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('unread-thread-card').first()
		await expect(card).toBeVisible()

		const input = card.getByPlaceholder('Write a comment... Use @ to mention an agent')
		await expect(input).toBeVisible()

		const measure = () =>
			input.evaluate((el) => {
				const ta = el as HTMLTextAreaElement
				return {
					clientHeight: ta.clientHeight,
					scrollWidth: ta.scrollWidth,
					clientWidth: ta.clientWidth,
				}
			})

		const before = await measure()

		// A long unbroken sequence is the worst case — it cannot break on a
		// space, so the textarea must rely on `break-words` to wrap. Followed by
		// a few additional words so the wrapped layout has multiple visual lines.
		await input.fill(
			`${'x'.repeat(200)} and then some more words that should wrap onto additional lines as the textarea grows in height`,
		)

		await expect
			.poll(async () => (await measure()).clientHeight, {
				message: 'textarea height should grow as text wraps',
				timeout: 2000,
			})
			.toBeGreaterThan(before.clientHeight)

		const after = await measure()
		// No horizontal overflow inside the textarea.
		expect(after.scrollWidth, 'textarea must not overflow horizontally').toBeLessThanOrEqual(
			after.clientWidth + 1,
		)
	})
})
