import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You sparse-state composer (T1 of bet `foryou-sparse-composer`).
//
// AC-U1: composer renders inside the empty state when `items.length === 0`.
// AC-U2: composer renders directly below items when `1 ≤ items.length < 3`.
// AC-U3: composer is hidden when `items.length >= 3`.
// AC-U4: typing + Enter opens the chat panel with the message staged.
//
// The unread feed is mocked at the `/api/subscriptions/unread` boundary so the
// spec stays deterministic regardless of what the real backend seeds. The chat
// surface itself is verified to open — the persistent session bootstrap is
// covered by chat.spec.ts and not re-exercised here.

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

function buildItem(workspaceId: string, n: number): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: `bet-${n}`,
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 1,
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

async function mockUnreadCount(page: Page, workspaceId: string, count: number) {
	const items = Array.from({ length: count }, (_, i) => buildItem(workspaceId, i + 1))
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

const COMPOSER_LABEL = 'Start a chat with agents'

test.describe('For You sparse composer', () => {
	test('renders inside the empty state when items.length === 0 (AC-U1)', async ({
		page,
		account,
	}) => {
		await mockUnreadCount(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByText('All caught up')).toBeVisible()
		const composer = page.getByTestId('sparse-composer')
		await expect(composer.getByLabel(COMPOSER_LABEL)).toBeVisible()
		await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible()
		// AC-U7: quick-start chips only show on the 0-item branch.
		await expect(page.getByTestId('sparse-composer-chips')).toBeVisible()
	})

	test('renders below items when 1 ≤ items.length < 3 (AC-U2)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 2)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('sparse-composer').getByLabel(COMPOSER_LABEL)).toBeVisible()
		// Chips are 0-item-only.
		await expect(page.getByTestId('sparse-composer-chips')).toHaveCount(0)
	})

	test('is hidden when items.length >= 3 (AC-U3)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 3)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('unread-thread-card').first()).toBeVisible()
		await expect(page.getByTestId('sparse-composer')).toHaveCount(0)
	})

	test('typing + Enter opens the chat panel (AC-U4)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)
		const input = page.getByTestId('sparse-composer').getByLabel(COMPOSER_LABEL)
		await input.fill('Plan a launch')
		await input.press('Enter')
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })
		// AC-U4: input clears after the call resolves.
		await expect(input).toHaveValue('')
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`composer + send button visible at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockUnreadCount(page, account.workspaceId, 0)
			await page.goto(`/${account.workspaceId}`)
			const composer = page.getByTestId('sparse-composer')
			await expect(composer.getByLabel(COMPOSER_LABEL)).toBeVisible()
			await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible()
		})
	}
})
