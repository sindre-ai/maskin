import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T5 of bet `maskin-mobile-app`: a push-notification tap opens the app on the
// correct For You card, not the top of the sort. On device, the AppDelegate
// stashes the payload in the Rust bridge and the JS side rewrites the URL to
// `?card=<entity_type>:<entity_id>`. This spec drives the same URL shape
// directly — the browser doesn't need APNs to prove the routing works — and
// asserts the card queue pins the tapped card as the current one.

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
	entityId: string,
	title: string,
	overrides: Partial<UnreadFixture> = {},
): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: entityId,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: new Date().toISOString(),
		object: { id: entityId, title, type: 'bet', status: 'active', content: '', workspaceId },
		...overrides,
	}
}

async function mockUnread(page: Page, workspaceId: string, items: UnreadFixture[]) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`For You — push-notification deep-link @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('lands directly on the tapped card when `?card=<type>:<id>` is set', async ({
			page,
			account,
		}) => {
			const items = [
				buildItem(account.workspaceId, 'top-of-sort', 'Would win the sort'),
				buildItem(account.workspaceId, 'tapped', 'Tapped from notification'),
				buildItem(account.workspaceId, 'other', 'Some other item'),
			]
			await mockUnread(page, account.workspaceId, items)

			await page.goto(`/${account.workspaceId}?card=object:tapped`)

			// The single-card queue only mounts the current head — the fact that
			// exactly one card is mounted AND it's the tapped one is the whole
			// contract: no full-feed reload, no jumping-past-the-top-of-sort UX.
			const card = page.locator('[data-card-kind]')
			await expect(card).toHaveCount(1)
			await expect(card).toContainText('Tapped from notification')
		})

		test('falls back to the top-of-sort card when the requested key is not in the queue', async ({
			page,
			account,
		}) => {
			const items = [buildItem(account.workspaceId, 'first', 'First item')]
			await mockUnread(page, account.workspaceId, items)

			// A stale notification whose card was resolved elsewhere — the URL
			// still carries the request, but the queue can only surface what's
			// there right now.
			await page.goto(`/${account.workspaceId}?card=object:not-in-queue`)

			const card = page.locator('[data-card-kind]')
			await expect(card).toHaveCount(1)
			await expect(card).toContainText('First item')
		})
	})
}
