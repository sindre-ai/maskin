import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You "Mentioned" pill — `mentioning_unread_count` shape (T5 on bet/notif-cascade-fix).
//
// The pill (`aria-label="Mentioned"`, text "@you") appears on an UnreadThreadCard
// when `mentioning_unread_count > 0` and must be absent when the count is 0.
// Previously the API returned `mentions_you: boolean` (bool_or over the thread);
// it now returns a per-event count so a single buried agent→agent mention in a
// long thread no longer flags the whole object.
//
// The unread feed is mocked at `/api/subscriptions/unread` so the spec is
// deterministic regardless of backend seed state.

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

function buildItem(workspaceId: string, mentioningUnreadCount: number): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: 'bet-mention-test',
		unread_count: 3,
		mentioning_unread_count: mentioningUnreadCount,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'bet-mention-test',
			title: 'Mention pill test bet',
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

test.describe('Mentioned pill on UnreadThreadCard', () => {
	test('renders @you pill when mentioning_unread_count > 0', async ({ page, account }) => {
		await page.route('**/api/subscriptions/unread*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: [buildItem(account.workspaceId, 1)] }),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('unread-thread-card').first()
		await expect(card).toBeVisible()
		await expect(card.getByLabel('Mentioned')).toBeVisible()
	})

	test('omits @you pill when mentioning_unread_count === 0', async ({ page, account }) => {
		await page.route('**/api/subscriptions/unread*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: [buildItem(account.workspaceId, 0)] }),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('unread-thread-card').first()
		await expect(card).toBeVisible()
		await expect(card.getByLabel('Mentioned')).toHaveCount(0)
	})

	test('pill visible with count > 1 (multiple mentioning events)', async ({ page, account }) => {
		await page.route('**/api/subscriptions/unread*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: [buildItem(account.workspaceId, 3)] }),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('unread-thread-card').first()
		await expect(card).toBeVisible()
		await expect(card.getByLabel('Mentioned')).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`@you pill visible at ${viewport.label} when mentioning_unread_count > 0`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.route('**/api/subscriptions/unread*', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [buildItem(account.workspaceId, 1)] }),
				})
			})
			await page.goto(`/${account.workspaceId}`)
			const card = page.getByTestId('unread-thread-card').first()
			await expect(card).toBeVisible()
			await expect(card.getByLabel('Mentioned')).toBeVisible()
		})
	}
})
