import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T3 of bet foryou-brief-feed: prove the For You feed renders real
// notifications/asks from live workspace data and that the no-regression
// surfaces (filter chips, keep-unread / mark-as-read, queue advance + item
// pinning, empty state) still behave against a real-shaped feed with zero
// console errors.
//
// The decision-block option rows and reason rows are surfaces owned by T2
// (foryou-queue-card.tsx / lib/foryou-card-kind.ts) — not asserted here.
//
// Unread + thread APIs are mocked (repo convention, same as
// foryou-prototype-responsive.spec.ts) with fully live-shaped items.

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
	overrides: Partial<Omit<UnreadFixture, 'object'>> & {
		id: string
		title: string
		type: string
		status?: string
		content?: string
		metadata?: Record<string, string> | null
	},
): UnreadFixture {
	const { id, title, type, status, content, metadata, ...rest } = overrides
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
			status: status ?? (type === 'task' ? 'in_review' : 'active'),
			content: content ?? 'Preview line leads the card body before the action UI.',
			workspaceId,
			metadata: metadata ?? null,
		},
		...rest,
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

// Collect page + console errors so "no console errors" is executable evidence,
// not a code-inspection claim.
function trackErrors(page: Page): { errors: string[] } {
	const errors: string[] = []
	page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`))
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return
		// The browser emits "Failed to load resource: 404/400" console.error for
		// background resource loads (fonts, images, favicon) on every page in
		// this harness — they are noise, not app errors, and the feed's own
		// endpoints are mocked to 200. Filter that single channel; keep real
		// app-level console.error and uncaught page errors as the signal.
		if (/failed to load resource/i.test(msg.text())) return
		errors.push(`console.error: ${msg.text()}`)
	})
	return { errors }
}

async function gotoForyou(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}`)
}

test.describe('For You feed — renders real data from the live feed (ship-gate viewports)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`${vp.label}: card renders real title, status, zero console errors`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const { errors } = trackErrors(page)
			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'thread-live',
					title: 'Renewal terms need a read',
					type: 'insight',
					status: 'active',
				}),
			])
			await gotoForyou(page, account.workspaceId)

			const card = page.getByTestId('foryou-queue-card')
			await expect(card).toBeVisible()
			await expect(card).toContainText('Renewal terms need a read')
			// Status comes from the item's real `object.status`.
			await expect(card.getByText('active', { exact: true })).toBeVisible()

			expect(errors).toEqual([])
		})
	}
})

test.describe('For You feed — no-regression surfaces against a real feed', () => {
	test.use({ viewport: { width: 375, height: 812 } })

	test('filter chips actually filter a mixed real feed', async ({ page, account }) => {
		const { errors } = trackErrors(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'insight-1',
				title: 'Customer call follow-up',
				type: 'insight',
				content: 'Notes from the renewal call, needing action.',
			}),
			buildItem(account.workspaceId, {
				id: 'task-1',
				title: 'Approve migration playbook',
				type: 'task',
				content: 'Task summary: sign off on the rolling migration.',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		await expect(page.getByTestId('foryou-queue-card')).toContainText(/customer call follow-up/i)

		await page.getByRole('button', { name: /^Task/ }).click()
		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toContainText('Approve migration playbook')
		await expect(card).not.toContainText('Customer call follow-up')

		// Switching to a mutually-exclusive type chip excludes the pinned task
		// from the queue, so the queue advances back to the insight item.
		await page.getByRole('button', { name: /^Insight/ }).click()
		const cardAfterInsight = page.getByTestId('foryou-queue-card')
		await expect(cardAfterInsight).toContainText('Customer call follow-up')
		await expect(cardAfterInsight).not.toContainText('Approve migration playbook')

		expect(errors).toEqual([])
	})

	test('conversation history before the unread boundary collapses behind the scroll-up hint, against real thread data', async ({
		page,
		account,
	}) => {
		const { errors } = trackErrors(page)
		const entityId = 'long-thread'

		// The card's thread fetch (`GET /events/history`) hits the real backend
		// for every other route in this file — this test alone needs real-shaped
		// comment events, so it stubs that one endpoint directly rather than
		// seeding real rows.
		await page.route('**/api/events/history*', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			const url = new URL(route.request().url())
			if (url.searchParams.get('entity_id') !== entityId) return route.fallback()
			// The API returns events newest-first.
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{
						id: 3,
						workspaceId: account.workspaceId,
						actorId: 'other-actor',
						action: 'commented',
						entityType: 'object',
						entityId,
						data: { content: 'Newest unread reply.' },
						createdAt: new Date().toISOString(),
					},
					{
						id: 2,
						workspaceId: account.workspaceId,
						actorId: 'other-actor',
						action: 'commented',
						entityType: 'object',
						entityId,
						data: { content: 'Second earlier comment, already read.' },
						createdAt: new Date().toISOString(),
					},
					{
						id: 1,
						workspaceId: account.workspaceId,
						actorId: 'other-actor',
						action: 'commented',
						entityType: 'object',
						entityId,
						data: { content: 'First earlier comment, already read.' },
						createdAt: new Date().toISOString(),
					},
				]),
			})
		})

		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: entityId,
				title: 'Long-form writeup',
				type: 'insight',
				unread_count: 1,
			}),
		])
		await gotoForyou(page, account.workspaceId)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card.getByText('Newest unread reply.')).toBeVisible()
		await expect(card.getByText('Second earlier comment, already read.')).not.toBeVisible()
		await expect(card.getByText('First earlier comment, already read.')).not.toBeVisible()

		await card.getByRole('button', { name: 'Scroll up to load 2 earlier messages' }).click()

		await expect(card.getByText('Second earlier comment, already read.')).toBeVisible()
		await expect(card.getByText('First earlier comment, already read.')).toBeVisible()
		await expect(card.getByRole('button', { name: /Scroll up to load/ })).not.toBeVisible()

		expect(errors).toEqual([])
	})

	test('keep-unread advances and mark-as-read drains to the empty state; no console errors', async ({
		page,
		account,
	}) => {
		const { errors } = trackErrors(page)
		const readCalls: unknown[] = []
		await page.route('**/api/subscriptions/read', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			try {
				readCalls.push(route.request().postDataJSON())
			} catch {
				readCalls.push(null)
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ updated: true }),
			})
		})

		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-a',
				title: 'First thread to read',
				type: 'insight',
				content: 'Summary A from live data.',
			}),
			buildItem(account.workspaceId, {
				id: 'thread-b',
				title: 'Second thread to read',
				type: 'insight',
				content: 'Summary B from live data.',
			}),
		])
		await gotoForyou(page, account.workspaceId)

		// "Keep unread" is a pure skip — no mutation, advances to the next item.
		await expect(page.getByTestId('foryou-queue-card')).toContainText('First thread to read')
		await page.getByRole('button', { name: 'Keep unread' }).click()
		await expect(page.getByTestId('foryou-queue-card')).toContainText('Second thread to read')
		await page.waitForTimeout(600)
		expect(readCalls).toHaveLength(0)

		// "Mark as read" commits and drains the queue to the empty state.
		await page.getByRole('button', { name: 'Mark as read' }).click()
		await expect(page.getByText("You're caught up")).toBeVisible()
		await page.waitForTimeout(4800)
		expect(readCalls.length).toBeGreaterThanOrEqual(1)

		expect(errors).toEqual([])
	})
})
