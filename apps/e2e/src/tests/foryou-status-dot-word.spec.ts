import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You card head — v2b canonical dot+word status pill.
//
// Verifies the pill is present at every ship-gate viewport, carries the
// object's status ("Status <status>" via aria-label), and renders the
// leading colored dot the v2b spec prescribes. Uses the same mocked-unread
// pattern as unread-mentioned-pill.spec.ts so the assertion is deterministic
// regardless of backend seed state.

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

function buildItem(workspaceId: string, status: string): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: 'bet-status-pill-test',
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'bet-status-pill-test',
			title: 'Status pill test bet',
			type: 'bet',
			status,
			workspaceId,
		},
	}
}

test.describe('For You status pill (dot+word)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders leading dot + word for the object status at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.route('**/api/subscriptions/unread*', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [buildItem(account.workspaceId, 'in_progress')] }),
				})
			})
			await page.goto(`/${account.workspaceId}`)
			const card = page.getByTestId('foryou-queue-card').first()
			await expect(card).toBeVisible()

			const pill = card.getByLabel('Status in progress')
			await expect(pill).toBeVisible()
			await expect(pill).toContainText('in progress')

			// Leading dot is present (aria-hidden decoration; assert via test id).
			const dot = pill.locator('[data-testid="status-dot"]')
			await expect(dot).toHaveCount(1)
		})
	}

	test('reflects a different status verbatim (label + aria)', async ({ page, account }) => {
		await page.route('**/api/subscriptions/unread*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: [buildItem(account.workspaceId, 'active')] }),
			})
		})
		await page.goto(`/${account.workspaceId}`)
		const card = page.getByTestId('foryou-queue-card').first()
		await expect(card).toBeVisible()
		await expect(card.getByLabel('Status active')).toBeVisible()
	})
})
