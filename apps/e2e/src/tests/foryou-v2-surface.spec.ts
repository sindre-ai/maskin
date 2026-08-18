import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// v2 For You surface (mockup 280–516). Covers the pieces the earlier
// prototype specs don't: the nav title/subtitle contract, the pill chip row
// and its `cuFilterShow` gate, the three-way sort, the card header band
// (type tile + attribution + mobile Mark read), the SUMMARY band, the
// scroll-up history hint and the "N NEW MESSAGES" divider, list-mode
// selection returning to Cards pinned on the item, and the caught-up panel.
//
// The unread feed and the thread's event history are mocked so the surface is
// deterministic; display settings and the briefing hit the real backend.

interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentioning_unread_count: number
	max_unread_attention: number | null
	latest_event_id: number
	latest_activity_at: string
	object: {
		id: string
		title: string
		type: string
		status: string
		content: string | null
		workspaceId: string
		metadata?: Record<string, string> | null
	}
}

function buildItem(
	workspaceId: string,
	overrides: {
		id: string
		title: string
		type: string
		status?: string
		content?: string | null
		unread_count?: number
		latest_activity_at?: string
		max_unread_attention?: number | null
	},
): UnreadFixture {
	const { id, title, type, status, content, ...rest } = overrides
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: rest.unread_count ?? 1,
		mentioning_unread_count: 0,
		max_unread_attention: rest.max_unread_attention ?? null,
		latest_event_id: 42,
		latest_activity_at: rest.latest_activity_at ?? new Date().toISOString(),
		object: {
			id,
			title,
			type,
			status: status ?? 'active',
			content: content === undefined ? 'Signup drop-off concentrates on step two.' : content,
			workspaceId,
			metadata: null,
		},
	}
}

function mixedFeed(workspaceId: string): UnreadFixture[] {
	return [
		buildItem(workspaceId, {
			id: 'bet-1',
			title: 'Renewal terms need a read',
			type: 'bet',
			max_unread_attention: 5,
			latest_activity_at: '2026-08-15T00:00:00.000Z',
		}),
		buildItem(workspaceId, {
			id: 'insight-1',
			title: 'Follow-up from customer call',
			type: 'insight',
			max_unread_attention: 2,
			latest_activity_at: '2026-08-01T00:00:00.000Z',
		}),
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

// Three comments on `entityId`, one of which is unread — enough to produce
// both the earlier-history hint and the unread divider.
async function mockThread(page: Page, workspaceId: string, entityId: string) {
	await page.route('**/api/events/history*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const url = new URL(route.request().url())
		if (url.searchParams.get('entity_id') !== entityId) return route.fallback()
		const base = {
			workspaceId,
			actorId: 'other-actor',
			action: 'commented',
			entityType: 'object',
			entityId,
			createdAt: new Date().toISOString(),
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{ ...base, id: 3, data: { content: 'Newest unread reply.' } },
				{ ...base, id: 2, data: { content: 'Second earlier comment.' } },
				{ ...base, id: 1, data: { content: 'First earlier comment.' } },
			]),
		})
	})
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(
		scrollWidth,
		`${label}: page overflows horizontally — scrollWidth=${scrollWidth} innerWidth=${innerWidth}`,
	).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('For You v2 — nav identity, chips and sort', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`nav owns the title and the only New control @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, mixedFeed(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			await expect(page.getByRole('heading', { name: 'For you', level: 1 })).toBeVisible({
				timeout: 10_000,
			})
			// The page-level duplicate is gone — the split New button in the nav
			// is the single create affordance on this screen.
			await expect(page.getByRole('button', { name: /^new$/i })).toHaveCount(1)

			// The muted subtitle rides the nav's title row; it is hidden below sm.
			if (vp.width >= 640) {
				await expect(page.getByText('2 unread')).toBeVisible()
			}

			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`chip row is centred on the card column and carries type swatches @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, mixedFeed(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			const all = page.getByRole('button', { name: 'All (2)' })
			await expect(all).toBeVisible({ timeout: 10_000 })
			const bet = page.getByRole('button', { name: 'Bet (1)' })
			await expect(bet).toBeVisible()

			// Active chip is the ink fill; inactive chips carry a leading type
			// swatch (mockup 286).
			await expect(all).toHaveClass(/bg-primary/)
			await expect(bet.locator('.bg-type-bet-text')).toHaveCount(1)

			// The row shares the card queue's 760px column.
			const chipBox = await all.boundingBox()
			const cardBox = await page.getByTestId('foryou-queue-card').boundingBox()
			if (!chipBox || !cardBox) throw new Error(`${vp.label}: missing layout box`)
			expect(Math.abs(chipBox.x - cardBox.x)).toBeLessThan(4)

			// Filtering to Bet keeps only the bet card in the queue.
			await bet.click()
			await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText(
				'Renewal terms need a read',
			)
		})
	}

	test('Display popover offers three sorts and Oldest first reorders the queue', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		await mockFeed(page, mixedFeed(account.workspaceId))
		await page.goto(`/${account.workspaceId}`)

		const card = page.locator('[data-testid="foryou-queue-card"]:visible')
		// Default "Most urgent" fronts the highest-attention item.
		await expect(card).toContainText('Renewal terms need a read', { timeout: 10_000 })

		await page.getByRole('button', { name: /display options/i }).click()
		await expect(page.getByRole('radio', { name: /most urgent/i })).toBeVisible()
		await expect(page.getByRole('radio', { name: /newest first/i })).toBeVisible()
		await page.getByRole('radio', { name: /oldest first/i }).click()
		await page.keyboard.press('Escape')

		// Oldest first fronts the item with the oldest latest_activity_at.
		await expect(card).toContainText('Follow-up from customer call')
	})

	test('the whole chip/Display row disappears once the feed is drained', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		await mockFeed(page, [])
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByText("You're caught up")).toBeVisible({ timeout: 10_000 })
		await expect(page.getByRole('button', { name: /^All/ })).toHaveCount(0)
		await expect(page.getByRole('button', { name: /display options/i })).toHaveCount(0)
	})
})

test.describe('For You v2 — card header, summary and thread', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`header band, summary and unread divider render @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockThread(page, account.workspaceId, 'bet-1')
			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'bet-1',
					title: 'Renewal terms need a read',
					type: 'bet',
					content: 'Signup drop-off concentrates on step two of the onboarding flow.',
				}),
			])
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-queue-card')
			await expect(card).toBeVisible({ timeout: 10_000 })

			// Status reads as a dot + word in the header's meta line.
			await expect(card.getByLabel('Status active')).toBeVisible()

			// SUMMARY band carries the object's own body, clamped inside the card.
			const summary = page.getByTestId('card-summary')
			await expect(summary).toBeVisible()
			await expect(summary).toContainText('Signup drop-off concentrates on step two')
			const summaryBox = await summary.boundingBox()
			const cardBox = await card.boundingBox()
			if (!summaryBox || !cardBox) throw new Error(`${vp.label}: missing layout box`)
			expect(summaryBox.width).toBeLessThanOrEqual(cardBox.width + 1)

			// Earlier history sits behind the scroll-up hint until asked for.
			const hint = card.getByRole('button', { name: /Scroll up to load 2 earlier messages/ })
			await expect(hint).toBeVisible()
			await expect(card.getByText('First earlier comment.')).toHaveCount(0)
			await hint.click()
			await expect(card.getByText('First earlier comment.')).toBeVisible()

			// The unread divider is labelled with the count and carries its own
			// mark-read action.
			const divider = card.getByLabel('Unread divider')
			await expect(divider).toContainText(/1 new message/i)

			await assertNoHorizontalOverflow(page, vp.label)
		})
	}

	test('the header Mark read button is reachable on touch at 375 and drains the card', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await page.route('**/api/subscriptions/read', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ updated: true }),
			})
		})
		await mockFeed(page, [
			buildItem(account.workspaceId, {
				id: 'bet-1',
				title: 'Renewal terms need a read',
				type: 'bet',
			}),
		])
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('foryou-queue-card')
		await expect(card).toBeVisible({ timeout: 10_000 })
		const markRead = card.getByRole('button', { name: 'Mark read' })
		await expect(markRead).toBeVisible()
		await markRead.click()

		await expect(page.getByText("You're caught up")).toBeVisible()
	})

	test('the bottom bar shows two outline buttons with arrow hints at 1024', async ({
		page,
		account,
	}) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		await mockFeed(page, mixedFeed(account.workspaceId))
		await page.goto(`/${account.workspaceId}`)

		const keep = page.getByRole('button', { name: 'Keep unread' })
		const read = page.getByRole('button', { name: 'Mark as read' })
		await expect(keep).toBeVisible({ timeout: 10_000 })
		await expect(read).toBeVisible()
		// Neither is the filled primary any more.
		await expect(read).not.toHaveClass(/bg-primary/)
		await expect(keep.locator('kbd')).toHaveText('←')
		await expect(read.locator('kbd')).toHaveText('→')
		// The header's mobile-only Mark read is not doubled up here.
		await expect(page.getByRole('button', { name: 'Mark read' })).toHaveCount(0)
	})
})

test.describe('For You v2 — list mode selection', () => {
	test('clicking a list row returns to Cards pinned on that item', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		await mockFeed(page, mixedFeed(account.workspaceId))
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('button', { name: /display options/i }).click()
		await page.getByRole('tab', { name: /list/i }).click()
		await page.keyboard.press('Escape')

		const row = page.getByRole('button', { name: 'Follow-up from customer call' })
		await expect(row).toBeVisible({ timeout: 10_000 })
		await row.click()

		// Back in Cards, parked on the clicked item — not a navigation to the
		// object detail route.
		await expect(page.locator('[data-testid="foryou-queue-card"]:visible')).toContainText(
			'Follow-up from customer call',
		)
		expect(new URL(page.url()).pathname).toBe(`/${account.workspaceId}`)
	})
})

test.describe('For You v2 — caught-up panel', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders the flagship caught-up state @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, [])
			await page.goto(`/${account.workspaceId}`)

			const title = page.getByText("You're caught up")
			await expect(title).toBeVisible({ timeout: 10_000 })
			await expect(title).toHaveClass(/text-\[17px\]/)
			await expect(
				page.getByText('Nothing needs you right now. The loops keep running'),
			).toBeVisible()
			await expect(page.getByRole('link', { name: /review loops/i })).toBeVisible()
			// Brief lives in the nav — not repeated in this panel.
			await expect(page.getByRole('link', { name: /brief/i })).toHaveCount(0)

			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})

test.describe('For You v2 — tinted surfaces in light and dark', () => {
	for (const colorScheme of ['light', 'dark'] as const) {
		test(`active chip, unread divider and summary band stay legible in ${colorScheme} mode`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize(VIEWPORTS.tabletLandscape)
			await page.emulateMedia({ colorScheme })
			await mockThread(page, account.workspaceId, 'bet-1')
			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'bet-1',
					title: 'Renewal terms need a read',
					type: 'bet',
					content: 'Signup drop-off concentrates on step two of the onboarding flow.',
				}),
			])
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-queue-card')
			await expect(card).toBeVisible({ timeout: 10_000 })

			// Every tinted element resolves to a real, non-transparent colour in
			// both modes — the `bg-accent`-in-light-mode failure class.
			const targets = [
				page.getByRole('button', { name: 'All (1)' }),
				page.getByTestId('card-summary'),
				card.getByLabel('Unread divider').locator('.bg-brand-subtle'),
			]
			for (const target of targets) {
				await expect(target).toBeVisible()
				const { bg, fg } = await target.evaluate((el) => {
					const style = getComputedStyle(el)
					return { bg: style.backgroundColor, fg: style.color }
				})
				expect(bg).not.toBe('rgba(0, 0, 0, 0)')
				expect(fg).not.toBe(bg)
			}
		})
	}
})
