import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — the v4 feed (`Maskin For You - Feed v4`).
 *
 * One scrolling column: today's brief, then a card per unread thread. Cards
 * view expands them all, List view collapses them to rows, and an option taken
 * posts the reply and leaves a green receipt in the card's place.
 *
 * The unread feed is mocked so the surface is deterministic; display settings
 * and the briefing hit the real backend.
 */

interface FeedItemInput {
	id: string
	title: string
	type: string
	status: string
	content?: string | null
	hoursAgo?: number
	decision?: boolean
}

function buildItem(workspaceId: string, input: FeedItemInput) {
	return {
		entity_type: 'object' as const,
		entity_id: input.id,
		unread_count: 2,
		mentioning_unread_count: 0,
		max_unread_attention: 3,
		latest_event_id: 42,
		latest_activity_at: new Date(Date.now() - (input.hoursAgo ?? 4) * 3_600_000).toISOString(),
		object: {
			id: input.id,
			title: input.title,
			type: input.type,
			status: input.status,
			content: input.content === undefined ? 'Why this needs a person.' : input.content,
			workspaceId,
			driver: null,
			metadata: input.decision ? { decision_type: 'architecture' } : {},
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
			content: 'A page people use every day was rewritten and no human has opened it.',
			hoursAgo: 5,
			decision: true,
		}),
		buildItem(workspaceId, {
			id: 'task-edit-card',
			title: 'Finish the edit card, or cut it?',
			type: 'task',
			status: 'in_review',
			hoursAgo: 3,
		}),
		buildItem(workspaceId, {
			id: 'task-loop-detail',
			title: 'Merge the loop detail page?',
			type: 'task',
			status: 'in_review',
			hoursAgo: 4,
		}),
		buildItem(workspaceId, {
			id: 'insight-fyi',
			title: 'Is the feed too long?',
			type: 'insight',
			status: 'active',
			hoursAgo: 8,
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

async function mockFeed(page: Page, workspaceId: string, items = feed(workspaceId)) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
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

			// Today's brief leads the column, collapsed.
			const brief = page.getByTestId('brief-card')
			await expect(brief).toBeVisible()
			await expect(brief.getByText("Today's brief")).toBeVisible()

			// Cards view expands every card: the ask, the why and the composer.
			const cards = page.getByTestId('foryou-feed-card')
			await expect(cards.first()).toBeVisible()
			await expect(page.getByText('Merge the trigger settings rewrite?').first()).toBeVisible()
			await expect(
				page.getByText('A page people use every day was rewritten and no human has opened it.'),
			).toBeVisible()
			// Matches the v2 composer's default placeholder (both its mobile and
			// desktop wording). Once the Object detail split lands `placeholder`
			// on the composer — see the TODO in feed-card.tsx — this should
			// tighten back to /Reply to /.
			await expect(page.getByPlaceholder(/Write a comment/).first()).toBeVisible()

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
	test('renders one standalone card per unread thread', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-feed-card')).toHaveCount(5)
		// Every card is its own bordered block — the feed carries no group shells.
		await expect(page.getByTestId('foryou-feed-group')).toHaveCount(0)
	})

	test('taking an option posts it and leaves a receipt', async ({ page, account }) => {
		// The reply marks the thread read, so the server drops it from the unread
		// feed straight away — the receipt has to survive that refetch.
		let dropped = false
		await page.route('**/api/subscriptions/unread*', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			const items = feed(account.workspaceId).filter(
				(entry) => !dropped || entry.entity_id !== 'task-decision',
			)
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items }),
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
		await expect(decisionCard.getByRole('button', { name: 'Approve' })).toBeVisible()
		await expect(decisionCard.getByRole('button', { name: 'Send back' })).toBeVisible()

		await decisionCard.getByRole('button', { name: 'Approve' }).click()

		const receipt = page.getByTestId('decision-receipt')
		await expect(receipt).toBeVisible()
		await expect(receipt).toContainText('Approve')
		await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0)
		// The choice really went out as a reply on the thread.
		await expect.poll(() => posted?.content).toBe('Approve')
		// …and the receipt is still there once the feed has refetched without it.
		await page.waitForTimeout(1200)
		await expect(page.getByTestId('decision-receipt')).toBeVisible()
	})

	test('a plain thread offers no options, only a composer', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const fyi = page.getByTestId('foryou-feed-card').filter({ hasText: 'Is the feed too long?' })
		await expect(fyi.getByPlaceholder(/Write a comment/)).toBeVisible()
		await expect(fyi.getByRole('button', { name: 'Approve' })).toHaveCount(0)
		await expect(fyi.getByRole('button', { name: 'Sign off' })).toHaveCount(0)
	})

	test('the ··· menu carries the bulk actions with their counts', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('button', { name: 'Feed actions' }).click()
		await expect(page.getByRole('menuitem', { name: /Dismiss all FYIs/ })).toBeVisible()
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

		// Three of the five cards carry options: the two in-review tasks and the
		// decision. The plain insight and the blocked bet classify as threads,
		// which have nothing to answer.
		await expect(page.getByTestId('decision-receipt')).toHaveCount(3)
		await expect.poll(() => posted.length).toBe(3)
	})
})

test.describe("For You v4 — today's brief", () => {
	test('opens on the player with the transcript folded away', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const brief = page.getByTestId('brief-card')
		await expect(brief.getByTestId('brief-player')).toHaveCount(0)

		await brief.getByRole('button', { name: "Today's brief" }).click()
		// The brief is made to be listened to: player first, prose behind a link.
		await expect(brief.getByTestId('brief-player')).toBeVisible()
		const show = brief.getByRole('button', { name: 'Prefer to read? Show the transcript' })
		await expect(show).toBeVisible()

		await show.click()
		await expect(brief.getByRole('button', { name: 'Hide the transcript' })).toBeVisible()
	})
})

test.describe('For You v4 — the release note', () => {
	test('announces the update above the cards and stays dismissed', async ({ page, account }) => {
		await mockFeed(page, account.workspaceId)
		await page.goto(`/${account.workspaceId}`)

		const release = page.getByTestId('foryou-release-card')
		await expect(release).toBeVisible()
		await expect(release.getByText('Update')).toBeVisible()

		await release.getByRole('button', { name: 'Dismiss the release note' }).click()
		await expect(page.getByTestId('foryou-release-card')).toHaveCount(0)

		// Dismissal is per version and persisted, so a reload keeps it away.
		await page.reload()
		await expect(page.getByTestId('foryou-feed-card').first()).toBeVisible()
		await expect(page.getByTestId('foryou-release-card')).toHaveCount(0)
	})
})

test.describe('For You v4 — light and dark', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the brief card and the feed read in ${scheme} mode`, async ({ page, account }) => {
			await page.addInitScript((value) => {
				localStorage.setItem('maskin-theme', value)
			}, scheme)
			await mockFeed(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const brief = page.getByTestId('brief-card')
			await expect(brief).toBeVisible()
			await expect(brief.getByText("Today's brief")).toBeVisible()

			// The brief's surface is its own token pair, and it must stay distinct
			// from the page behind it in both themes.
			const [briefBg, pageBg] = await Promise.all([
				brief.evaluate((el) => getComputedStyle(el).backgroundColor),
				page.evaluate(() => getComputedStyle(document.body).backgroundColor),
			])
			expect(briefBg).not.toBe(pageBg)

			await expect(page.getByTestId('foryou-feed-card').first()).toBeVisible()
			await expect(page.getByRole('button', { name: 'Approve' }).first()).toBeVisible()
		})
	}
})
