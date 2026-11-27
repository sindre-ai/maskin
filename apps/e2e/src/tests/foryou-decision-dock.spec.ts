import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

/**
 * For You — where the answers sit. The decision options are the card's footer and
 * dock to the bottom edge of the feed while the card is on screen, so at least one
 * option is in view on first paint even when the draft runs long. They return to
 * flow after the draft at the card's end. The draft is never folded.
 *
 * The curated list is mocked so the surface is deterministic, as in
 * foryou-decision-bar.spec.ts.
 */

const DRAFT_LAST_LINE = 'This is the last line of the full draft and it must stay.'

/** A draft long enough that the card cannot fit one screen at any ship width. */
function longDraftBody(): string {
	const lines = ['Hi Jonas,']
	for (let index = 1; index <= 40; index += 1) {
		lines.push(`Line ${index}: the delivery schedule and the terms we agreed on the call.`)
	}
	lines.push(DRAFT_LAST_LINE)
	return lines.join('\n')
}

function decisionItem(workspaceId: string, actorId: string, body: string) {
	const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
	return {
		entity_type: 'object' as const,
		entity_id: 'task-jonas',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: 3,
		latest_event_id: 77,
		latest_activity_at: createdAt,
		object: {
			id: 'task-jonas',
			title: 'Reply to Jonas Vestergaard (Hotel Solsiden): st…',
			type: 'task',
			status: 'todo',
			content: '',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 77,
			actor_id: actorId,
			created_at: createdAt,
			content: 'Send the reply to Jonas yourself?',
			attention: 3,
			decision: {
				title: 'Send the reply to Jonas yourself?',
				summary:
					'Draft is ready with first delivery Monday 30 November; agents cannot send because Gmail is read only here.',
				ask: 'Send the reply to Jonas yourself?',
				draft: {
					label: 'Email to Jonas Vestergaard',
					to: 'Jonas Vestergaard',
					body,
				},
				options: [
					{
						label: 'I sent it',
						recommended: true,
						consequences: ['Jonas has the 30 November terms.'],
					},
					{ label: 'Edit first', consequences: ['Nothing sends until you edit'] },
					{ label: 'Hold', consequences: ['The draft waits for you'] },
				],
			},
		},
	}
}

async function mockFeed(page: Page, item: ReturnType<typeof decisionItem>) {
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						notification_id: '00000000-0000-4000-8000-000000000003',
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

// The widths the task names, plus the ship-gate tablet width. Heights are typical
// device heights so "first paint" is a realistic viewport.
const WIDTHS = [
	{ width: 375, height: 812, label: '375' },
	{ width: 517, height: 900, label: '517' },
	{ width: 768, height: 1024, label: '768' },
	{ width: 1024, height: 768, label: '1024' },
	{ width: 1440, height: 900, label: '1440' },
]

test.describe('For You — the decision answers dock', () => {
	for (const vp of WIDTHS) {
		test(`an answer is in view on first paint with a 40-line draft @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, decisionItem(account.workspaceId, account.actorId, longDraftBody()))
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card')
			await expect(card).toBeVisible()

			const recommended = card.getByRole('button', { name: 'I sent it' })
			await expect(recommended).toBeVisible()

			// First paint, before any scroll: the docked answers sit inside the viewport.
			const box = await recommended.boundingBox()
			expect(box, `${vp.label}: the recommended answer has no box`).not.toBeNull()
			if (box) {
				expect(box.y, `${vp.label}: answer above the viewport`).toBeGreaterThanOrEqual(0)
				expect(box.y + box.height, `${vp.label}: answer below the viewport`).toBeLessThanOrEqual(
					vp.height + 1,
				)
			}

			// The footer is docked while the long draft runs under it, so it carries the shadow.
			const dock = card.getByTestId('foryou-decision-dock')
			await expect(dock).toHaveAttribute('data-docked', 'true')

			// The draft is whole: its last line is rendered, not folded or clipped away.
			await expect(card.getByText(DRAFT_LAST_LINE, { exact: false })).toBeVisible()

			await assertNoHorizontalOverflow(page, vp.label)

			// Scroll to the card's end: the footer leaves the dock and settles in flow.
			await card.evaluate((node) => {
				let ancestor: HTMLElement | null = node.parentElement
				while (ancestor && getComputedStyle(ancestor).overflowY !== 'auto') {
					ancestor = ancestor.parentElement
				}
				if (ancestor) ancestor.scrollTop = ancestor.scrollHeight
			})
			await expect(dock).toHaveAttribute('data-docked', 'false')
		})
	}
})
