import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * For You — a card when it has little room.
 *
 * At 375 and 517 the card header used to cut the object line to one truncated
 * line ("…: st…") and the agent to "Chief of…", while the timeline control,
 * status, age and close crowded one line. A long email address in a draft
 * broke mid-word. 768 has the same problem for a different reason: the sidebar
 * appears there and takes 248px, so the card is about 456px, narrower than the
 * 477px card at 517. The header therefore keys off the card's own width, not the
 * window's, and must read at all three, while a wide card looks as it does today.
 */

const SENDER_NAME = 'Chief of Staff'
const OBJECT_TITLE = 'Reply to Jonas Vestergaard (Hotel Solsiden): start the reply'
const ADDRESS = 'jonas.vestergaard@hotelsolside-n.example'
const DRAFT_ID = '22222222-2222-4222-8222-222222222222'

/** Widths where the card is too narrow for a single line, with a height that matches. */
const NARROW_VIEWPORTS = [
	{ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height },
	{ width: 517, height: 812 },
	{ width: VIEWPORTS.tabletPortrait.width, height: VIEWPORTS.tabletPortrait.height },
] as const

/** Widths where the card is wide enough for one line and one meta row. */
const WIDE_VIEWPORTS = [VIEWPORTS.tabletLandscape, VIEWPORTS.desktop] as const

function narrowCardItem(workspaceId: string, senderId: string) {
	const createdAt = new Date(Date.now() - 3 * 3_600_000).toISOString()
	const preview = {
		kind: 'email',
		label: 'Email to Jonas Vestergaard',
		provider: 'gmail',
		recipients: [{ role: 'to', name: 'Jonas Vestergaard', address: ADDRESS }],
		subject: 'Re: Your stay',
		body: 'Hi Jonas,\n\nThanks for reaching out. I can send you the details today.',
		maxLength: 100_000,
		missing: [],
		warnings: [],
		content_hash: 'hash-of-the-text-on-the-card',
		delivery: { state: 'draft' },
	}
	return {
		entity_type: 'object' as const,
		entity_id: 'task-narrow-card',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: 3,
		latest_event_id: 88,
		latest_activity_at: createdAt,
		object: {
			id: 'task-narrow-card',
			title: OBJECT_TITLE,
			type: 'task',
			status: 'todo',
			content: 'The durable spec, which the card must not show.',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 88,
			actor_id: senderId,
			created_at: createdAt,
			content: 'Send the reply to Jonas yourself?',
			attention: 3,
			decision: {
				title: 'Send the reply to Jonas yourself?',
				summary:
					'Draft is ready with first delivery Monday 30 November; agents cannot send because Gmail is read only here.',
				ask: 'This leaves from your own mailbox, so I will not send it alone.',
				options: [
					{ label: 'Hold', consequences: ['Nothing is sent', 'Jonas keeps waiting'] },
					{
						label: 'Send it',
						recommended: true,
						destructive: true,
						consequences: ['Goes out now', 'Cannot be recalled'],
					},
				],
				draft: { object_id: DRAFT_ID, label: preview.label, body: preview.body, preview },
			},
		},
	}
}

async function mockFeed(page: Page, item: ReturnType<typeof narrowCardItem>) {
	// A fresh workspace has no briefing pages, but say so on the wire so the row
	// cannot race the feed assertion.
	await page.route('**/api/files**', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const url = new URL(route.request().url())
		if (!url.pathname.endsWith('/api/files')) return route.fallback()
		return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
	})
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						notification_id: '00000000-0000-4000-8000-000000000099',
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
	await page.waitForTimeout(150)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

function overlaps(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** A layout box the assertions need; failing loudly beats a silent `undefined`. */
function required<T>(value: T | null): T {
	if (value === null) throw new Error('expected an element with a bounding box')
	return value
}

/** Open the card's meta controls, which the fix must keep apart on a narrow card. */
function metaControls(card: ReturnType<Page['getByTestId']>) {
	return {
		timeline: card.getByRole('button', { name: 'Show timeline history' }),
		status: card.locator('[aria-label="Status todo"]'),
		age: card.locator('time').first(),
		close: card.getByRole('button', { name: 'Mark as read' }),
	}
}

test.describe('For You — a card with little room', () => {
	for (const { width, height } of NARROW_VIEWPORTS) {
		test(`reads and keeps its controls apart @ ${width}`, async ({ page, account }) => {
			await page.setViewportSize({ width, height })
			const sender = await account.api.createAgentActor(SENDER_NAME, account.workspaceId)
			await mockFeed(page, narrowCardItem(account.workspaceId, sender.id))
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card').first()
			await expect(card).toBeVisible()

			// The card, not the window, is what has to have room. At 768 the sidebar takes
			// 248px, so this card is narrower than the one at 517 despite the wider window.
			const cardBox = required(await card.boundingBox())
			if (width === VIEWPORTS.tabletPortrait.width) {
				expect(cardBox.width, 'the card is narrower at 768 than at 517').toBeLessThan(490)
			}

			// The object line wraps to two lines instead of being cut to one.
			const objectLink = card.locator('a').first()
			await expect(objectLink).toContainText('start the reply')
			const clamp = await objectLink
				.locator('span')
				.first()
				.evaluate((el) => getComputedStyle(el).webkitLineClamp)
			expect(clamp, 'object line should wrap to two lines on a narrow card').toBe('2')

			// The agent name is shown whole, not truncated to "Chief of…".
			const byline = card.getByText(SENDER_NAME, { exact: true })
			await expect(byline).toBeVisible()
			const bylineCut = await byline.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
			expect(bylineCut, 'agent name should not be truncated').toBe(false)
			const bylineBox = required(await byline.boundingBox())

			// Timeline, status, age and close each take room of their own.
			const controls = metaControls(card)
			const boxes = await Promise.all([
				required(await controls.timeline.boundingBox()),
				required(await controls.status.boundingBox()),
				required(await controls.age.boundingBox()),
				required(await controls.close.boundingBox()),
			])
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					expect(overlaps(boxes[i], boxes[j]), `control ${i} overlaps control ${j}`).toBe(false)
				}
			}

			// The controls move to a line of their own, under the name.
			const timelineBox = boxes[0]
			expect(timelineBox.y).toBeGreaterThan(bylineBox.y + bylineBox.height - 1)

			// The address breaks only where an address may: at the @, a dot or a hyphen.
			const draft = card.getByRole('region', { name: 'Email to Jonas Vestergaard' })
			const to = draft.locator('dd').first()
			await expect(to).toContainText(ADDRESS)
			const addressStyle = await to.evaluate((el) => ({
				overflowWrap: getComputedStyle(el).overflowWrap,
				breaks: el.querySelectorAll('wbr').length,
			}))
			expect(addressStyle.overflowWrap).toBe('normal')
			expect(addressStyle.breaks).toBeGreaterThanOrEqual(3)

			await assertNoHorizontalOverflow(page, `${width}px`)
		})
	}

	test('still reads in dark mode @ 517', async ({ page, account }) => {
		await page.setViewportSize({ width: 517, height: 812 })
		await page.emulateMedia({ colorScheme: 'dark' })
		const sender = await account.api.createAgentActor(SENDER_NAME, account.workspaceId)
		await mockFeed(page, narrowCardItem(account.workspaceId, sender.id))
		await page.goto(`/${account.workspaceId}`)

		await expect(page.locator('html')).toHaveClass(/dark/)
		const card = page.getByTestId('foryou-feed-card').first()
		await expect(card.getByText(SENDER_NAME, { exact: true })).toBeVisible()
		await expect(card.getByText('Send the reply to Jonas yourself?').first()).toBeVisible()
		await assertNoHorizontalOverflow(page, '517px dark')
	})

	for (const { width, height } of WIDE_VIEWPORTS) {
		test(`looks as it does today on a wide card @ ${width}`, async ({ page, account }) => {
			await page.setViewportSize({ width, height })
			const sender = await account.api.createAgentActor(SENDER_NAME, account.workspaceId)
			await mockFeed(page, narrowCardItem(account.workspaceId, sender.id))
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card').first()
			await expect(card).toBeVisible()

			// One ellipsised line, as before.
			const clamp = await card
				.locator('a')
				.first()
				.locator('span')
				.first()
				.evaluate((el) => getComputedStyle(el).webkitLineClamp)
			expect(clamp, 'the object line should be one line on a wide card').toBe('1')

			// Name and controls share one row again.
			const bylineBox = required(await card.getByText(SENDER_NAME, { exact: true }).boundingBox())
			const timelineBox = required(
				await card.getByRole('button', { name: 'Show timeline history' }).boundingBox(),
			)
			const bylineCentre = bylineBox.y + bylineBox.height / 2
			const timelineCentre = timelineBox.y + timelineBox.height / 2
			expect(Math.abs(bylineCentre - timelineCentre)).toBeLessThan(8)

			await assertNoHorizontalOverflow(page, `${width}px wide`)
		})
	}
})
