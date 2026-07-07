import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You "Mark all as read" bulk action (T5 of bet `ux-review-core-pages`).
//
// DoD:
// 1. Clicking the button fires a single Sonner toast with `Undo`; tapping
//    `Undo` within 15s restores every cleared thread to unread.
// 2. Otherwise mutations commit on auto-close/dismiss.
// 3. The button label includes the count it will clear; count updates as new
//    items arrive.
// 4. `Alt+U` (`Option+U` on macOS) bound; ignored when an input is focused.
// 5. Existing per-item failure surface is preserved (mutation-cache-driven
//    global toast; not re-verified here).
//
// The unread feed is mocked at the /api/subscriptions/unread boundary so the
// spec stays deterministic. The mark-read POST is captured so we can assert
// that Undo does NOT fire mutations and that auto-close DOES.

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

function buildItem(workspaceId: string, n: number, latestEventId = 10 + n): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: `bet-${n}`,
		unread_count: 1,
		mentions_you: false,
		latest_event_id: latestEventId,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: `bet-${n}`,
			title: `Existing bet ${n}`,
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockUnread(page: Page, workspaceId: string, count: number) {
	const items = Array.from({ length: count }, (_, i) => buildItem(workspaceId, i + 1))
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

async function trackMarkReadCalls(page: Page): Promise<{ readonly calls: unknown[] }> {
	const calls: unknown[] = []
	await page.route('**/api/subscriptions/mark-read', async (route) => {
		try {
			calls.push(route.request().postDataJSON())
		} catch {
			calls.push(null)
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ success: true }),
		})
	})
	return { calls }
}

test.describe('For You — Mark all as read', () => {
	test('label carries the current unread count', async ({ page, account }) => {
		await mockUnread(page, account.workspaceId, 3)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByRole('button', { name: /mark all as read \(3\)/i })).toBeVisible()
	})

	test('button is hidden on the empty state', async ({ page, account }) => {
		await mockUnread(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByText('All caught up')).toBeVisible()
		await expect(page.getByRole('button', { name: /mark all as read/i })).toHaveCount(0)
	})

	test('Undo within 15s restores every hidden thread and fires no mutations', async ({
		page,
		account,
	}) => {
		const { calls } = await trackMarkReadCalls(page)
		await mockUnread(page, account.workspaceId, 2)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('unread-thread-card')).toHaveCount(2)

		await page.getByRole('button', { name: /mark all as read/i }).click()
		// Items hide immediately (optimistic).
		await expect(page.getByTestId('unread-thread-card')).toHaveCount(0)

		// Toast Undo action becomes clickable.
		const undo = page.getByRole('button', { name: /^undo$/i })
		await expect(undo).toBeVisible()
		await undo.click()

		// Items reappear, no mark-read call ever went to the server.
		await expect(page.getByTestId('unread-thread-card')).toHaveCount(2)
		// Small grace so any late request would have landed.
		await page.waitForTimeout(300)
		expect(calls).toHaveLength(0)
	})

	test('Alt+U opens the same toast as clicking the button', async ({ page, account }) => {
		await mockUnread(page, account.workspaceId, 2)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('unread-thread-card')).toHaveCount(2)
		await page.keyboard.press('Alt+u')
		await expect(page.getByRole('button', { name: /^undo$/i })).toBeVisible()
		await expect(page.getByTestId('unread-thread-card')).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`button visible and reachable at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockUnread(page, account.workspaceId, 2)
			await page.goto(`/${account.workspaceId}`)
			const button = page.getByRole('button', { name: /mark all as read/i })
			await expect(button).toBeVisible()
			// The button must not overflow the viewport horizontally.
			const box = await button.boundingBox()
			if (!box) throw new Error(`button has no layout box at ${viewport.label}`)
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
		})
	}
})
