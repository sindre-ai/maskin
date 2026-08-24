import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The pre-v2 For You feed — `components/foryou/legacy/` — rendered when the
// `new-design` flag is off, which is what every actor outside
// FF_TESTER_ACTOR_IDS gets. Feed v4 replaced the specs that used to cover this
// queue; this one keeps the flag's off branch executable until the flag (and
// the legacy tree with it) is deleted.
//
// The auth fixture seeds `ff:new-design = 'on'` for every spec, so each test
// here sets 'off' explicitly through the same test-only override
// feature-flag-shell.spec.ts uses.

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
		metadata: Record<string, string> | null
	}
}

function buildItem(
	workspaceId: string,
	overrides: { id: string; title: string; content: string },
): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: overrides.id,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 42,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: overrides.id,
			title: overrides.title,
			type: 'insight',
			status: 'active',
			content: overrides.content,
			workspaceId,
			metadata: null,
		},
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

// Executable evidence for "no console errors", filtering only the background
// resource-load channel this harness emits on every page.
function trackErrors(page: Page): { errors: string[] } {
	const errors: string[] = []
	page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`))
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return
		if (/failed to load resource/i.test(msg.text())) return
		errors.push(`console.error: ${msg.text()}`)
	})
	return { errors }
}

async function setFlagOff(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:new-design', 'off')
	})
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`${vp.label}: the legacy queue renders a card with no console errors`, async ({
		page,
		account,
	}) => {
		await setFlagOff(page)
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const { errors } = trackErrors(page)
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'thread-legacy',
				title: 'Renewal terms need a read',
				content: 'Preview line leads the card body.',
			}),
		])

		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toBeVisible()
		await expect(card).toContainText('Renewal terms need a read')
		// The v4 feed must not be mounted on this branch.
		await expect(page.getByTestId('foryou-feed-card')).toHaveCount(0)

		expect(errors).toEqual([])
	})
}

test('keep-unread advances without mutating; mark-as-read commits and drains the queue', async ({
	page,
	account,
}) => {
	await setFlagOff(page)
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
			content: 'Summary A.',
		}),
		buildItem(account.workspaceId, {
			id: 'thread-b',
			title: 'Second thread to read',
			content: 'Summary B.',
		}),
	])

	await page.goto(`/${account.workspaceId}`)

	// "Keep unread" is a pure skip — it advances the queue and writes nothing.
	await expect(page.getByTestId('foryou-queue-card')).toContainText('First thread to read')
	await page.getByRole('button', { name: 'Keep unread' }).click()
	await expect(page.getByTestId('foryou-queue-card')).toContainText('Second thread to read')
	await page.waitForTimeout(600)
	expect(readCalls).toHaveLength(0)

	// "Mark as read" commits the high-water mark and empties the queue.
	await page.getByRole('button', { name: 'Mark as read' }).click()
	await expect(page.getByText("You're caught up")).toBeVisible()
	await page.waitForTimeout(4800)
	expect(readCalls.length).toBeGreaterThanOrEqual(1)

	expect(errors).toEqual([])
})
