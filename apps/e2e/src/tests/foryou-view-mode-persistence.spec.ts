import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Task 34171a61 — persist the For You page's list/card view selection per
// user. The view mode rides the existing per-actor `__chrome__` display
// settings row (`foryouViewMode: 'card' | 'list'`) — the same store the
// objects page and the object-detail sidebar use — so there is no new API.
// These tests guard three behaviors at each ship-gate viewport:
//   - a user who never switches keeps the card queue (default, no 404 -> write)
//   - choosing List writes through a PUT to `__chrome__` with the right body
//   - list is restored on reload (the settings GET hydrates the mode)
//
// Unread feed is mocked (see foryou-prototype-responsive.spec.ts for the
// same pattern); display settings hit the real backend since persistence is
// exactly what's under test.
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

function buildItem(workspaceId: string, id: string, title: string, type: string): UnreadFixture {
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
			status: 'active',
			content: 'Preview line leads the card body before the action UI.',
			workspaceId,
			metadata: null,
		},
	}
}

function plainFeed(workspaceId: string): UnreadFixture[] {
	return [
		buildItem(workspaceId, 'thread-1', 'Renewal terms need a read', 'insight'),
		buildItem(workspaceId, 'thread-2', 'Follow-up from customer call', 'insight'),
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

test.describe('For You view-mode persistence via __chrome__ display settings', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`defaults to cards, persists List through a PUT, and restores it after reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, plainFeed(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			// A user who never switched stays on the card queue. The queue card
			// only exists in cards mode, so its presence is what proves we are
			// not in list mode — card titles render as links too, so link-role
			// counting cannot distinguish the two modes here.
			const queueCard = page.getByTestId('foryou-queue-card')
			await expect(queueCard).toHaveCount(1, { timeout: 10_000 })
			await expect(queueCard).toContainText('Renewal terms need a read')

			// Choosing List writes through to the per-actor __chrome__ row. The
			// rail is set up before the click so the PUT response can't be missed.
			const [putResponse] = await Promise.all([
				page.waitForResponse(
					(r) =>
						r.url().includes('/api/user-display-settings/__chrome__') &&
						r.request().method() === 'PUT',
					{ timeout: 10_000 },
				),
				(async () => {
					await page.getByRole('button', { name: /display options/i }).click()
					await page.getByRole('tab', { name: /list/i }).click()
				})(),
			])
			expect(putResponse.ok()).toBe(true)
			const body = putResponse.request().postDataJSON()
			expect(body.settings.foryouViewMode).toBe('list')

			// List rows replace the card queue.
			await expect(page.getByRole('link', { name: 'Renewal terms need a read' })).toBeVisible()
			await expect(page.getByRole('link', { name: 'Follow-up from customer call' })).toBeVisible()
			await expect(queueCard).toHaveCount(0)

			// Reload restores the persisted list — hydration, not first-paint default.
			await page.reload()
			await expect(page.getByRole('link', { name: 'Renewal terms need a read' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('link', { name: 'Follow-up from customer call' })).toBeVisible()
			await expect(queueCard).toHaveCount(0)
		})
	}
})
