import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// AC 4 of bet `foryou-decision-tool`: only attention_needed=true notifications
// surface in For You, grouped into four buckets (Decision needed / Waiting on
// agents / FYI / Handled today), same-objectId items collapsed with a bulk
// action. This spec seeds one notification per bucket + a same-object pair to
// prove:
//
// 1. Four bucket headers render in order.
// 2. Same-objectId notifications collapse into one grouped card.
// 3. The grouped card shows a bulk-approve button when a recommendation exists.
// 4. Clicking bulk-approve POSTs to /api/notifications/bulk-respond with the
//    collapsed ids and the shared recommendation.

interface NotificationFixture {
	id: string
	workspaceId: string
	type: 'needs_input' | 'recommendation' | 'good_news' | 'alert'
	title: string
	content: string | null
	metadata: Record<string, unknown> | null
	sourceActorId: string
	targetActorId: string | null
	objectId: string | null
	sessionId: string | null
	status: 'pending' | 'seen' | 'resolved' | 'dismissed' | 'expired'
	resolvedAt: string | null
	expiresAt: string | null
	defaultAction: string | null
	dispatchAt: string | null
	wakeDispatched: boolean
	createdAt: string
	updatedAt: string
}

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const OBJ_SHARED = '22222222-2222-4222-8222-222222222222'
const OBJ_WAITING = '33333333-3333-4333-8333-333333333333'
const OBJ_FYI = '44444444-4444-4444-8444-444444444444'
const OBJ_HANDLED = '55555555-5555-4555-8555-555555555555'

function buildNotification(
	workspaceId: string,
	overrides: Partial<NotificationFixture> & Pick<NotificationFixture, 'id' | 'title'>,
): NotificationFixture {
	const now = new Date().toISOString()
	return {
		workspaceId,
		type: 'needs_input',
		content: null,
		metadata: null,
		sourceActorId: AGENT_ID,
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		expiresAt: null,
		defaultAction: null,
		dispatchAt: null,
		wakeDispatched: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

async function mockNotifications(page: Page, workspaceId: string) {
	const bulkCalls: Array<{ ids: string[]; response: unknown }> = []
	const notifications: NotificationFixture[] = [
		buildNotification(workspaceId, {
			id: '66666666-6666-4666-8666-666666666601',
			title: 'Approve draft A',
			objectId: OBJ_SHARED,
			metadata: {
				attention_needed: true,
				options: [{ label: 'Send', value: 'send', default: true }],
				recommendation: 'send',
			},
		}),
		buildNotification(workspaceId, {
			id: '66666666-6666-4666-8666-666666666602',
			title: 'Approve draft B',
			objectId: OBJ_SHARED,
			metadata: {
				attention_needed: true,
				options: [{ label: 'Send', value: 'send', default: true }],
				recommendation: 'send',
			},
		}),
		buildNotification(workspaceId, {
			id: '66666666-6666-4666-8666-666666666603',
			title: 'Waking source agent',
			objectId: OBJ_WAITING,
			status: 'resolved',
			resolvedAt: new Date().toISOString(),
			dispatchAt: new Date(Date.now() + 3000).toISOString(),
			wakeDispatched: false,
			metadata: { attention_needed: true },
		}),
		buildNotification(workspaceId, {
			id: '66666666-6666-4666-8666-666666666604',
			title: 'Loop finished',
			type: 'good_news',
			objectId: OBJ_FYI,
			metadata: { attention_needed: true },
		}),
		buildNotification(workspaceId, {
			id: '66666666-6666-4666-8666-666666666605',
			title: 'Already handled today',
			status: 'resolved',
			objectId: OBJ_HANDLED,
			resolvedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
			wakeDispatched: true,
			metadata: { attention_needed: true },
		}),
	]

	await page.route('**/api/notifications**', async (route: Route) => {
		const req = route.request()
		const url = new URL(req.url())

		if (req.method() === 'GET' && url.pathname.endsWith('/api/notifications')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(notifications),
			})
			return
		}

		if (req.method() === 'POST' && url.pathname.endsWith('/api/notifications/bulk-respond')) {
			const body = req.postDataJSON() as { ids: string[]; response: unknown }
			bulkCalls.push(body)
			const resolved = notifications
				.filter((n) => body.ids.includes(n.id))
				.map((n) => ({ ...n, status: 'resolved' as const, resolvedAt: new Date().toISOString() }))
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(resolved),
			})
			return
		}

		await route.fallback()
	})

	// The landing route also fetches /api/subscriptions/unread for the list-mode
	// path and sidebar counts. Stub with an empty response so the shell renders
	// without a network stall.
	await page.route('**/api/subscriptions/unread*', async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})

	return { bulkCalls }
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`For You buckets @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('renders four bucket headers and collapses same-object notifications with a bulk action', async ({
			page,
			account,
		}) => {
			await mockNotifications(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			// Container mounts once notifications resolve.
			await expect(page.getByTestId('foryou-card-queue')).toBeVisible()

			// Four buckets render in AC order.
			const buckets = page.getByTestId('foryou-bucket')
			await expect(buckets).toHaveCount(4)
			await expect(page.getByRole('heading', { name: 'Decision needed' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Waiting on agents' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'FYI' })).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Handled today' })).toBeVisible()

			// The two same-object drafts collapse into one grouped card with a bulk action.
			const groupedCard = page
				.getByTestId('foryou-group-card')
				.filter({ has: page.locator(`[data-object-id="${OBJ_SHARED}"]`) })
			await expect(groupedCard).toHaveCount(1)
			await expect(groupedCard).toHaveAttribute('data-group-size', '2')
			await expect(groupedCard.getByTestId('foryou-bulk-approve')).toHaveText(/approve all 2/i)
		})

		test('bulk-approve calls /api/notifications/bulk-respond with the collapsed ids and shared recommendation', async ({
			page,
			account,
		}) => {
			const { bulkCalls } = await mockNotifications(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const groupedCard = page
				.getByTestId('foryou-group-card')
				.filter({ has: page.locator(`[data-object-id="${OBJ_SHARED}"]`) })
			await groupedCard.getByTestId('foryou-bulk-approve').click()

			await expect.poll(() => bulkCalls.length).toBe(1)
			expect(bulkCalls[0].response).toBe('send')
			expect(bulkCalls[0].ids).toEqual([
				'66666666-6666-4666-8666-666666666601',
				'66666666-6666-4666-8666-666666666602',
			])
		})
	})
}
