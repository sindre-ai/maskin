import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Minimal For You redesign (AC-U7, U8, U9):
//   - Page head shows the "For You" heading + "Unread threads on things you follow" subtitle
//     with filter tabs (All / Mentions), a Mark-all-read action and a New button on the same row.
//   - Day-group headers (Today / Yesterday / Earlier) partition the feed.
//   - Cards use a hairline top rule and a 2px left-border accent for unread items
//     (warning tone when the viewer is @-mentioned), no outer ring or bg-card shell.
//   - Empty state renders calm chrome with no broken card rules.
//   - No page-level horizontal overflow at 375 / 768 / 1024.
//
// The unread feed is mocked so the spec stays deterministic and the layout is
// asserted against a known set of buckets (today mention + earlier fyi).

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
		content?: string
	}
}

function buildItem(
	workspaceId: string,
	overrides: Partial<UnreadFixture> & { id: string; title: string },
): UnreadFixture {
	const { id, title, ...rest } = overrides
	return {
		entity_type: 'object',
		entity_id: id,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: new Date().toISOString(),
		object: {
			id,
			title,
			type: 'bet',
			status: 'active',
			workspaceId,
			content: 'Insight preview text — leads before the agent take on this thread.',
		},
		...rest,
	}
}

async function mockFeed(page: Page, items: UnreadFixture[]) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
	// Cards fetch their thread events on visibility; empty is fine for layout.
	await page.route('**/api/events*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

test.describe('For You minimal layout', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`heading, filter tabs, day groups and unread accent at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const nowIso = new Date().toISOString()
			const earlierIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'bet-today-mention',
					title: 'Today mention bet',
					mentioning_unread_count: 1,
					latest_activity_at: nowIso,
					latest_event_id: 42,
				}),
				buildItem(account.workspaceId, {
					id: 'bet-earlier-fyi',
					title: 'Earlier fyi bet',
					latest_activity_at: earlierIso,
					latest_event_id: 24,
				}),
			])

			await page.goto(`/${account.workspaceId}`)

			// AC-U7: heading + subtitle.
			await expect(page.getByRole('heading', { level: 1, name: 'For You' })).toBeVisible()
			await expect(page.getByText('Unread threads on things you follow')).toBeVisible()

			// Filter tabs with counts.
			const filters = page.getByRole('group', { name: 'Filter unread feed' })
			await expect(filters).toBeVisible()
			await expect(filters.getByRole('button', { name: /All \(2\)/ })).toBeVisible()
			await expect(filters.getByRole('button', { name: /Mentions \(1\)/ })).toBeVisible()

			// Mark-all-read stays on the same actions row (visible at every ship-gate viewport).
			await expect(page.getByRole('button', { name: /Mark all as read \(2\)/ })).toBeVisible()

			// Day groups render as headings, in the mocked order.
			await expect(page.getByRole('heading', { level: 2, name: 'Today' })).toBeVisible()
			await expect(page.getByRole('heading', { level: 2, name: 'Earlier' })).toBeVisible()

			// Both cards visible; mention card lands in Today, fyi card in Earlier.
			const cards = page.getByTestId('unread-thread-card')
			await expect(cards).toHaveCount(2)

			// Mentioned card gets the warning-tone left border accent.
			const mentionInner = cards.first().locator(':scope > div').nth(1)
			const mentionClass = (await mentionInner.getAttribute('class')) ?? ''
			expect(mentionClass).toMatch(/border-l-warning/)

			// Non-mention card gets the default primary-tone accent.
			const fyiInner = cards.nth(1).locator(':scope > div').nth(1)
			const fyiClass = (await fyiInner.getAttribute('class')) ?? ''
			expect(fyiClass).toMatch(/border-l-primary/)

			// Insight preview (from object.content) renders above the take.
			await expect(page.getByText(/Insight preview text/).first()).toBeVisible()

			// No page-level horizontal overflow at any ship-gate viewport.
			const horizScroll = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(horizScroll, `document must not horizontally scroll at ${viewport.label}`).toBe(false)
		})

		test(`Mentions filter narrows the feed at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await mockFeed(page, [
				buildItem(account.workspaceId, {
					id: 'bet-mention',
					title: 'Mention bet',
					mentioning_unread_count: 1,
				}),
				buildItem(account.workspaceId, {
					id: 'bet-fyi',
					title: 'Plain fyi bet',
				}),
			])

			await page.goto(`/${account.workspaceId}`)

			await expect(page.getByTestId('unread-thread-card')).toHaveCount(2)

			await page
				.getByRole('group', { name: 'Filter unread feed' })
				.getByRole('button', { name: /Mentions \(1\)/ })
				.click()

			await expect(page.getByTestId('unread-thread-card')).toHaveCount(1)
			await expect(page.getByText('Mention bet')).toBeVisible()
			await expect(page.getByText('Plain fyi bet')).not.toBeVisible()
		})

		test(`empty state renders calmly at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockFeed(page, [])

			await page.goto(`/${account.workspaceId}`)

			// AC-U8: empty state text without broken card chrome.
			await expect(page.getByText('All caught up')).toBeVisible()
			await expect(page.getByTestId('unread-thread-card')).toHaveCount(0)

			const horizScroll = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(horizScroll).toBe(false)
		})
	}
})
