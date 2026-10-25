import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — how a decision is answered. One full-width dark bar carries the recommended
 * option, the other options sit in one quiet row beneath it, and what the agent expects to
 * happen is a single line of small print. A card that carries several replies keeps a quiet
 * Send / Skip on each, so the bar is the only filled button on the card.
 *
 * The curated list is mocked so the surface is deterministic, as in foryou-email-preview.
 */

function threeRepliesItem(workspaceId: string) {
	const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
	const drafts = ['Kristin Hallgren', 'Hans Martin Maersk-Moller', 'Philip Andersen'].map(
		(to, index) => ({
			id: `reply-${index}`,
			label: `Reply to ${to}`,
			to,
			body: `Hi ${to.split(' ')[0]}, picking up on what you said. Want to see how it works?`,
		}),
	)
	return {
		entity_type: 'object' as const,
		entity_id: 'task-replies',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: 3,
		latest_event_id: 88,
		latest_activity_at: createdAt,
		object: {
			id: 'task-replies',
			title: 'Warm replies',
			type: 'task',
			status: 'in_review',
			content: '',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 88,
			actor_id: null,
			created_at: createdAt,
			content: 'Approve three warm replies?',
			attention: 3,
			decision: {
				title: 'Approve three warm replies?',
				summary: 'Three prospects replied in live threads and are waiting on an answer.',
				ask: 'I will not send into your own threads without you.',
				options: [
					{ label: 'Edit first', consequences: ['Nothing sends until you edit'] },
					{ label: 'Skip', consequences: ['Threads stay unanswered'] },
					{
						label: 'Send all three',
						recommended: true,
						consequences: ['All three replies go out today', 'The booking link is in each'],
					},
				],
				drafts,
			},
		},
	}
}

async function mockFeed(page: Page, item: ReturnType<typeof threeRepliesItem>) {
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						notification_id: '00000000-0000-4000-8000-000000000002',
						rank: 1,
						headline: item.latest_mention.content,
						rationale: null,
						created_at: item.latest_activity_at,
						entity_type: item.entity_type,
						entity_id: item.entity_id,
						session_id: null,
						object: item.object,
						latest_mention: item.latest_mention,
					},
				],
			}),
		})
	})
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('For You — the decision bar', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`one bar, quiet alternates, one line of reasons @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, threeRepliesItem(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card')
			await expect(card).toBeVisible()

			const bar = card.getByRole('button', { name: 'Send all three' })
			// The decision's Skip, not the per-reply Skip each of the three replies keeps.
			const skip = card.locator('[data-action-id="skip"]')
			const edit = card.getByRole('button', { name: 'Edit first' })
			await expect(bar).toBeVisible()
			await expect(skip).toBeVisible()
			await expect(edit).toBeVisible()

			// The bar leads: it sits above the alternates and spans the card's content width.
			const barBox = await bar.boundingBox()
			const editBox = await edit.boundingBox()
			expect(barBox && editBox && barBox.y < editBox.y).toBe(true)
			expect(barBox && editBox && barBox.width > editBox.width).toBe(true)

			// What the agent expects is one line, not a box per option.
			await expect(
				card.getByText(
					'Suggested: Send all three. All three replies go out today. The booking link is in each.',
				),
			).toBeVisible()
			await expect(card.getByText('Nothing sends until you edit')).toHaveCount(0)

			// Each reply can still be decided on its own, with a quiet Send.
			await expect(card.getByRole('button', { name: 'Send', exact: true })).toHaveCount(3)
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}

	for (const scheme of ['light', 'dark'] as const) {
		test(`the bar reads in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await mockFeed(page, threeRepliesItem(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			const bar = page
				.getByTestId('foryou-feed-card')
				.getByRole('button', { name: 'Send all three' })
			await expect(bar).toBeVisible()
			const colors = await bar.evaluate((node) => {
				const style = getComputedStyle(node)
				return { color: style.color, background: style.backgroundColor }
			})
			expect(colors.color).not.toBe(colors.background)
		})
	}

	test('choosing the bar answers the whole card', async ({ page, account }) => {
		await mockFeed(page, threeRepliesItem(account.workspaceId))
		let reply: { content?: string } | null = null
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			reply = route.request().postDataJSON()
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ id: 99, action: 'commented' }),
			})
		})
		await page.goto(`/${account.workspaceId}`)

		await page
			.getByTestId('foryou-feed-card')
			.getByRole('button', { name: 'Send all three' })
			.click()

		await expect(page.getByTestId('decision-receipt')).toBeVisible()
		await expect.poll(() => reply?.content).toBe('Send all three')
	})
})
