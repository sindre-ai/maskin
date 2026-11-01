import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — the v4 feed (`Maskin For You - Feed v4`).
 *
 * One scrolling column: the briefing cards, then a card per curated item. Cards
 * view expands them all, List view collapses them to rows, and an option taken
 * posts the reply and leaves a green receipt in the card's place.
 *
 * The curated For You list and the briefing files are mocked so the surface is deterministic; display settings
 * hit the real backend.
 */

interface FeedItemInput {
	id: string
	/** The ask — the decision's title, or the comment's opening line. */
	title: string
	type: string
	status: string
	/** The object's own name, shown in the meta line as context. */
	objectTitle?: string
	hoursAgo?: number
	decision?: boolean
	/** Comment body under the opening line. Long, to prove nothing is cut. */
	body?: string
}

// Every card in the feed exists because an agent @-mentioned the reader, so
// each fixture item carries that comment. `decision: true` makes it a
// structured ask, whose options become the card's buttons.
function buildItem(workspaceId: string, input: FeedItemInput) {
	return {
		entity_type: 'object' as const,
		entity_id: input.id,
		unread_count: 2,
		mentioning_unread_count: 2,
		max_unread_attention: 3,
		latest_event_id: 42,
		latest_activity_at: new Date(Date.now() - (input.hoursAgo ?? 4) * 3_600_000).toISOString(),
		object: {
			id: input.id,
			title: input.objectTitle ?? `${input.title} (object)`,
			type: input.type,
			status: input.status,
			content: 'The durable spec, which the card must not show.',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 42,
			actor_id: null,
			created_at: new Date(Date.now() - (input.hoursAgo ?? 4) * 3_600_000).toISOString(),
			content: input.body
				? `${input.title}

${input.body}`
				: input.title,
			attention: 3,
			decision: input.decision
				? {
						title: input.title,
						summary:
							'A page 200 people use every day was rewritten and nobody has opened it. I have run the suite.',
						ask: 'This ships to every workspace at once, so I will not merge it alone.',
						options: [
							{
								label: 'Send back',
								consequences: ['Nothing ships today', 'Costs another review round'],
							},
							{
								label: 'Merge now',
								recommended: true,
								consequences: ['Ships tonight', 'No rollback once migrations run'],
							},
						],
					}
				: null,
		},
	}
}

function feed(workspaceId: string) {
	return [
		buildItem(workspaceId, {
			id: 'task-decision',
			title: 'Merge the trigger settings rewrite?',
			type: 'task',
			status: 'in_review',
			hoursAgo: 5,
			decision: true,
		}),
		buildItem(workspaceId, {
			id: 'task-edit-card',
			title: 'Finish the edit card, or cut it?',
			type: 'task',
			status: 'in_review',
			hoursAgo: 3,
			decision: true,
		}),
		buildItem(workspaceId, {
			id: 'task-loop-detail',
			title: 'Merge the loop detail page?',
			type: 'task',
			status: 'in_review',
			hoursAgo: 4,
			decision: true,
		}),
		buildItem(workspaceId, {
			id: 'insight-fyi',
			title: 'Is the feed too long?',
			type: 'insight',
			status: 'active',
			hoursAgo: 8,
			body: `${'Context the reader must be able to finish on the card. '.repeat(20)}The last line of the ask.`,
		}),
		buildItem(workspaceId, {
			id: 'bet-held',
			title: 'Rent a cloud Mac?',
			type: 'bet',
			status: 'blocked',
			hoursAgo: 72,
		}),
	]
}

// The page reads the Chief of Staff's curated list; each fixture card is one
// of its items, in the order given.
function curated(items: ReturnType<typeof feed>) {
	return items.map((item, index) => ({
		notification_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		rank: index + 1,
		headline: item.latest_mention.content.split('\n')[0],
		rationale: null,
		created_at: item.latest_activity_at,
		entity_type: item.entity_type,
		entity_id: item.entity_id,
		session_id: null,
		object: item.object,
		latest_mention: item.latest_mention,
	}))
}

// Two HTML briefings, as the Chief of Staff and a loop would file them. The list
// carries no content; each card's title is read from its page.
const BRIEFING_PAGES = [
	{
		id: '0b1f6c1e-0000-4000-8000-000000000001',
		name: 'Briefing 2026-10-21.html',
		title: 'Two bets stalled; one needs your call',
	},
	{
		id: '0b1f6c1e-0000-4000-8000-000000000002',
		name: 'Pipeline 2026-10-20.html',
		title: 'Pipeline grew by four qualified leads',
	},
] as const

function briefingFile(workspaceId: string, page: (typeof BRIEFING_PAGES)[number], index: number) {
	const stamp = new Date(Date.UTC(2026, 9, 21 - index, 5)).toISOString()
	return {
		id: page.id,
		workspaceId,
		name: page.name,
		description: null,
		kind: 'briefing',
		mimeType: 'text/html',
		sizeBytes: 200,
		storageKey: `files/${page.id}`,
		createdBy: '00000000-0000-4000-8000-0000000000aa',
		createdAt: stamp,
		updatedAt: stamp,
	}
}

async function mockBriefings(page: Page, workspaceId: string) {
	// `**` at the end: a single `*` would not match `/api/files/<id>`, so each page's detail
	// request would skip this mock and 404 against the real server.
	await page.route('**/api/files**', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const url = new URL(route.request().url())
		if (url.pathname.endsWith('/api/files')) {
			if (url.searchParams.get('kind') !== 'briefing') return route.fallback()
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(BRIEFING_PAGES.map((p, i) => briefingFile(workspaceId, p, i))),
			})
		}
		const index = BRIEFING_PAGES.findIndex((p) => url.pathname.endsWith(`/api/files/${p.id}`))
		if (index === -1) return route.fallback()
		const found = BRIEFING_PAGES[index]
		if (!found) return route.fallback()
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				...briefingFile(workspaceId, found, index),
				content: `<!doctype html><html><head><title>${found.title}</title></head><body><h1>${found.title}</h1><p>All quiet otherwise.</p></body></html>`,
				encoding: 'utf8',
				url: '',
			}),
		})
	})
}

async function mockFeed(page: Page, workspaceId: string, items = feed(workspaceId)) {
	await mockBriefings(page, workspaceId)
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: curated(items) }),
		})
	})
}

async function openViewMenu(page: Page) {
	await page.getByRole('button', { name: /view options/i }).click()
}

async function pickView(page: Page, label: RegExp) {
	await openViewMenu(page)
	await page.getByRole('menuitem', { name: label }).click()
	await page.keyboard.press('Escape')
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

test.describe('For You v4 — the feed at every ship-gate viewport', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`brief, cards and rows all render @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			// The briefing cards lead the column.
			const row = page.getByTestId('briefing-row')
			await expect(row).toBeVisible()
			await expect(row.getByTestId('briefing-card')).toHaveCount(BRIEFING_PAGES.length)
			await expect(row.getByText('Two bets stalled; one needs your call')).toBeVisible()

			// Cards view expands every card: the ask, the why and the composer.
			const cards = page.getByTestId('foryou-feed-card')
			await expect(cards.first()).toBeVisible()
			await expect(page.getByText('Merge the trigger settings rewrite?').first()).toBeVisible()
			await expect(
				cards.first().getByText(/A page 200 people use every day was rewritten/),
			).toBeVisible()
			// Matches the v2 composer's default placeholder (both its mobile and
			// desktop wording). Once the Object detail split lands `placeholder`
			// on the composer — see the TODO in feed-card.tsx — this should
			// tighten back to /Reply to /.
			await expect(page.getByPlaceholder(/Write a comment/).first()).toBeVisible()

			// A plain mention carries its whole body on the card — nothing is held
			// behind a "Read the rest" link any more.
			const fyiCard = cards.filter({ hasText: 'Is the feed too long?' })
			await expect(fyiCard.getByText('The last line of the ask.')).toBeVisible()
			await expect(page.getByText('Read the rest')).toHaveCount(0)

			await assertNoHorizontalOverflow(page, `${vp.label} cards`)

			// List view collapses them to one line each — the composer goes away.
			await pickView(page, /^List/)
			await expect(page.getByPlaceholder(/Write a comment/)).toHaveCount(0)
			await expect(page.getByText('Merge the trigger settings rewrite?').first()).toBeVisible()
			await assertNoHorizontalOverflow(page, `${vp.label} list`)

			// A row opens back up in place.
			await page.getByRole('button', { name: /Merge the trigger settings rewrite\?/ }).click()
			await expect(page.getByPlaceholder(/Write a comment/).first()).toBeVisible()
		})
	}
})

test.describe('For You v4 — cards, options and the receipt', () => {
	test('renders one standalone card per curated item', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-feed-card')).toHaveCount(5)
		// Every card is its own bordered block — the feed carries no group shells.
		await expect(page.getByTestId('foryou-feed-group')).toHaveCount(0)
	})

	test('the sidebar badge counts the curated items, not every unread mention', async ({
		page,
		account,
	}) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-feed-card')).toHaveCount(5)
		await expect(page.getByLabel('5 unread')).toBeVisible()
	})

	test('taking an option posts it and leaves a receipt', async ({ page, account }) => {
		// The reply marks the thread read, so the server drops it from the unread
		// feed straight away — the receipt has to survive that refetch.
		let dropped = false
		await page.route('**/api/for-you*', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			const items = feed(account.workspaceId).filter(
				(entry) => !dropped || entry.entity_id !== 'task-decision',
			)
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: curated(items) }),
			})
		})
		let posted: { entity_id?: string; content?: string } | null = null
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			posted = route.request().postDataJSON()
			dropped = true
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ id: 99, action: 'commented' }),
			})
		})
		await page.goto(`/${account.workspaceId}`)

		const decisionCard = page
			.getByTestId('foryou-feed-card')
			.filter({ hasText: 'Merge the trigger settings rewrite?' })
		// The card leads with the agent's ask, and its buttons are the options the
		// agent authored — including the consequence lines under each.
		await expect(decisionCard.getByRole('button', { name: 'Merge now' })).toBeVisible()
		await expect(decisionCard.getByRole('button', { name: 'Send back' })).toBeVisible()
		await expect(decisionCard.getByText('No rollback once migrations run')).toBeVisible()
		await expect(
			decisionCard.getByText(
				'This ships to every workspace at once, so I will not merge it alone.',
			),
		).toBeVisible()
		// The object's durable spec never reaches the card.
		await expect(
			decisionCard.getByText('The durable spec, which the card must not show.'),
		).toHaveCount(0)

		await decisionCard.getByRole('button', { name: 'Merge now' }).click()

		const receipt = page.getByTestId('decision-receipt')
		await expect(receipt).toBeVisible()
		await expect(receipt).toContainText('Merge now')
		await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0)
		// The choice really went out as a reply on the thread.
		await expect.poll(() => posted?.content).toBe('Merge now')
		// …and the receipt is still there once the feed has refetched without it.
		await page.waitForTimeout(1200)
		await expect(page.getByTestId('decision-receipt')).toBeVisible()
	})

	test('a plain thread offers no options, only a composer', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const fyi = page.getByTestId('foryou-feed-card').filter({ hasText: 'Is the feed too long?' })
		await expect(fyi.getByPlaceholder(/Write a comment/)).toBeVisible()
		await expect(fyi.getByRole('button', { name: 'Merge now' })).toHaveCount(0)
		await expect(fyi.getByRole('button', { name: 'Send back' })).toHaveCount(0)
	})

	test('the ··· menu carries the bulk actions with their counts', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('button', { name: 'Feed actions' }).click()
		// There are no FYIs on a curated list, so there is nothing to bulk-dismiss as one.
		await expect(page.getByRole('menuitem', { name: /Dismiss all FYIs/ })).toHaveCount(0)
		await expect(page.getByRole('menuitem', { name: /Take every suggested option/ })).toBeVisible()
		await expect(page.getByRole('menuitem', { name: /Dismiss all/ }).last()).toBeVisible()
	})

	test('the filter pills stay off until the view menu switches them on', async ({
		page,
		account,
	}) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByRole('button', { name: /^Tasks \(/ })).toHaveCount(0)

		await openViewMenu(page)
		await page.getByRole('menuitem', { name: /Filter bar under the header/ }).click()
		await page.keyboard.press('Escape')

		await expect(page.getByRole('button', { name: /^Tasks \(/ })).toBeVisible()
		await page.getByRole('button', { name: /^Insights \(/ }).click()
		await expect(page.getByTestId('foryou-feed-card')).toHaveCount(1)
		await expect(page.getByText('Is the feed too long?').first()).toBeVisible()
	})
})

test.describe('For You v4 — the card\u2019s own controls', () => {
	test('the timeline history loads only when it is opened, and folds away again', async ({
		page,
		account,
	}) => {
		await mockFeed(page, account.workspaceId)
		let historyRequests = 0
		await page.route('**/api/events/history*', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			const url = new URL(route.request().url())
			if (url.searchParams.get('entity_id') !== 'task-decision') return route.fallback()
			historyRequests++
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([
					{
						id: 3,
						workspaceId: account.workspaceId,
						actorId: account.actorId,
						action: 'commented',
						entityType: 'object',
						entityId: 'task-decision',
						data: { content: 'Second pass: both blockers hold.' },
						createdAt: new Date().toISOString(),
					},
				]),
			})
		})
		await page.goto(`/${account.workspaceId}`)

		const card = page
			.getByTestId('foryou-feed-card')
			.filter({ hasText: 'Merge the trigger settings rewrite?' })
		await expect(card.getByRole('button', { name: /Show timeline history/ })).toBeVisible()
		expect(historyRequests).toBe(0)

		await card.getByRole('button', { name: /Show timeline history/ }).click()
		await expect(card.getByText('On this object', { exact: true })).toBeVisible({ timeout: 10_000 })
		await expect(card.getByText('Second pass: both blockers hold.')).toBeVisible({
			timeout: 10_000,
		})
		expect(historyRequests).toBeGreaterThan(0)

		await card.getByRole('button', { name: 'Hide' }).click()
		await expect(card.getByText('On this object', { exact: true })).toHaveCount(0)
	})

	test('the per-card mark-as-read takes the card out of the feed', async ({ page, account }) => {
		let readCalls = 0
		await page.route('**/api/subscriptions/read', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			readCalls++
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		})
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('foryou-feed-card').filter({ hasText: 'Is the feed too long?' })
		await card.getByRole('button', { name: 'Mark as read' }).click()

		await expect(
			page.getByTestId('foryou-feed-card').filter({ hasText: 'Is the feed too long?' }),
		).toHaveCount(0)
		expect(readCalls).toBeGreaterThan(0)
	})

	test('"Take every suggested option" answers each open card at once', async ({
		page,
		account,
	}) => {
		const posted: string[] = []
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			const body = route.request().postDataJSON() as { content?: string }
			if (body?.content) posted.push(body.content)
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ id: 99, action: 'commented' }),
			})
		})
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('button', { name: 'Feed actions' }).click()
		await page.getByRole('menuitem', { name: /Take every suggested option/ }).click()

		// The bulk tap opens a confirm step first; nothing is posted until it is taken.
		const dialog = page.getByRole('dialog', { name: 'Take every suggested option?' })
		await expect(dialog).toBeVisible()
		expect(posted.length).toBe(0)
		await dialog.getByRole('button', { name: 'Answer 3 cards' }).click()

		// Three of the five cards carry an agent-authored decision. The plain
		// insight and the blocked bet are mentions with nothing to answer.
		await expect(page.getByTestId('decision-receipt')).toHaveCount(3)
		await expect.poll(() => posted.length).toBe(3)
	})
})

test.describe('For You v4 — the briefing cards', () => {
	test('opens a briefing as a page, and an opened card turns seen', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const cards = page.getByTestId('briefing-card')
		await expect(cards).toHaveCount(BRIEFING_PAGES.length)
		await expect(cards.first()).toHaveAttribute('data-seen', 'false')

		await cards.first().click()
		const viewer = page.getByTestId('briefing-viewer')
		await expect(viewer).toBeVisible()
		await expect(viewer.locator('iframe')).toBeVisible()
		await expect(
			viewer
				.frameLocator('iframe')
				.getByRole('heading', { name: 'Two bets stalled; one needs your call' }),
		).toBeVisible()

		// The side buttons sit outside the frame: they must be on screen and hit-testable (an
		// ancestor with overflow:hidden would clip them while Playwright still calls them visible).
		const next = viewer.getByRole('button', { name: 'Next briefing' })
		await expect(next).toBeVisible()
		const reachable = await next.evaluate((el) => {
			const r = el.getBoundingClientRect()
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
			return el.contains(hit)
		})
		expect(reachable).toBe(true)
		await next.click()
		await expect(viewer.getByText(/2 of 2/)).toBeVisible()

		await viewer.getByRole('button', { name: 'Previous briefing' }).click()
		await expect(viewer.getByText(/1 of 2/)).toBeVisible()
		await viewer.getByRole('button', { name: 'Next briefing' }).click()

		// Clicking the scrim beside the frame closes it, like the X.
		await page.mouse.click(8, 8)
		await expect(viewer).toHaveCount(0)

		// Both were opened, so both are seen, and that survives a reload.
		await page.reload()
		await expect(cards.first()).toHaveAttribute('data-seen', 'true')
	})

	test('draws nothing when there are no briefings', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.route('**/api/files*', async (route) => {
			const url = new URL(route.request().url())
			if (url.searchParams.get('kind') !== 'briefing') return route.fallback()
			await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
		})
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-feed-card').first()).toBeVisible()
		await expect(page.getByTestId('briefing-row')).toHaveCount(0)
	})
})

test.describe('For You v4 — light and dark', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the briefing cards and the feed read in ${scheme} mode`, async ({ page, account }) => {
			await page.addInitScript((value) => {
				localStorage.setItem('maskin-theme', value)
			}, scheme)
			await mockFeed(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			await expect(page.getByTestId('briefing-card').first()).toBeVisible()

			await expect(page.getByTestId('foryou-feed-card').first()).toBeVisible()
			await expect(page.getByRole('button', { name: 'Merge now' }).first()).toBeVisible()
		})
	}
})
