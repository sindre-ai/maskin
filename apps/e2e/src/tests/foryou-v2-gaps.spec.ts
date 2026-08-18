import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The For You / brief / palette gaps closed against the v2 mockup:
 *  - 419–424 the REC chip on the recommended decision option
 *  - 446–448 the "Replying to <name>" banner and its cancel
 *  - 457–472 the card composer's `+` menu and hint line
 *  - 492–496 the list row's trailing status dot + meta
 *  - 3414–3462 the brief player, "Listen instead", and MENTIONED chips
 *  - 3234–3259 the palette's Commands / Go to / Jump to / Search groups
 *
 * The unread feed and the thread history are mocked so the surface is
 * deterministic; objects, the palette index and display settings hit the real
 * backend.
 */

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

function decisionItem(workspaceId: string): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: 'gap-decision-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		max_unread_attention: 5,
		latest_event_id: 42,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'gap-decision-1',
			title: 'Ship the new onboarding copy',
			type: 'task',
			status: 'in_review',
			content: 'Signup drop-off concentrates on step two of the onboarding flow.',
			workspaceId,
			metadata: { decision_type: 'ux' },
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

async function mockThread(page: Page, workspaceId: string, entityId: string) {
	await page.route('**/api/events/history*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const url = new URL(route.request().url())
		if (url.searchParams.get('entity_id') !== entityId) return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					id: 1,
					workspaceId,
					actorId: 'other-actor',
					action: 'commented',
					entityType: 'object',
					entityId,
					createdAt: new Date().toISOString(),
					data: { content: 'Which onboarding copy should we ship?' },
				},
			]),
		})
	})
}

test.describe('For You v2 — decision card gaps', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`REC chip, reply banner and composer controls @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, [decisionItem(account.workspaceId)])
			await mockThread(page, account.workspaceId, 'gap-decision-1')
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-queue-card')
			await expect(card).toBeVisible({ timeout: 15_000 })

			// 419–424 — the recommended option is marked, the alternative is not.
			const approve = card.getByRole('button', { name: /Approve/ })
			await expect(approve.getByTestId('decision-rec')).toBeVisible()
			await expect(
				card.getByRole('button', { name: /Send back/ }).getByTestId('decision-rec'),
			).toHaveCount(0)

			// 446–448 — replying to a message names it, and can be cancelled.
			await expect(page.getByTestId('reply-banner')).toHaveCount(0)
			await card.getByRole('button', { name: 'Reply' }).first().click()
			const banner = page.getByTestId('reply-banner')
			await expect(banner).toBeVisible()
			await expect(banner).toContainText('Replying to')
			await banner.getByRole('button', { name: 'Cancel reply' }).click()
			await expect(page.getByTestId('reply-banner')).toHaveCount(0)

			// 457–472 / 8571–8575 — the `+` menu is reachable on touch and carries
			// all four affordances; the hint line sits beside it.
			const plus = card.getByRole('button', { name: 'Add a file, object, or mention' })
			await expect(plus).toBeVisible()
			await plus.click()
			await expect(page.getByRole('menuitem', { name: 'Attach a file' })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: 'Reference an object' })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: 'Mention an agent' })).toBeVisible()

			// "Attach a decision" opens the option editor; the options post as
			// metadata.chips and come back as quick-reply chips on the comment.
			await page.getByRole('menuitem', { name: 'Attach a decision' }).click()
			const editor = card.getByTestId('decision-attachment')
			await expect(editor).toBeVisible()
			await editor.getByRole('textbox', { name: 'Decision option' }).fill('Ship it')
			await editor.getByRole('button', { name: 'Add' }).click()
			await expect(editor).toContainText('Ship it')
			await editor.getByRole('button', { name: 'Remove option Ship it' }).click()
			await expect(editor).not.toContainText('Ship it')

			await expect(card.getByText(/to send/)).toBeVisible()
		})
	}

	test('light and dark both render the REC chip legibly', async ({ page, account }) => {
		await mockFeed(page, [decisionItem(account.workspaceId)])
		await mockThread(page, account.workspaceId, 'gap-decision-1')

		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme })
			await page.goto(`/${account.workspaceId}`)
			const rec = page
				.getByTestId('foryou-queue-card')
				.getByRole('button', { name: /Approve/ })
				.getByTestId('decision-rec')
			await expect(rec, `REC chip must be visible in ${scheme} mode`).toBeVisible({
				timeout: 15_000,
			})
		}
	})
})

test.describe('For You v2 — list rows', () => {
	test('a list row ends with the status dot and the trailing meta', async ({ page, account }) => {
		await mockFeed(page, [decisionItem(account.workspaceId)])
		await mockThread(page, account.workspaceId, 'gap-decision-1')
		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByTestId('foryou-queue-card')).toBeVisible({ timeout: 15_000 })
		await page.getByRole('button', { name: /display options/i }).click()
		await page.getByRole('tab', { name: /list/i }).click()
		await page.keyboard.press('Escape')

		const row = page.getByRole('button', { name: 'Ship the new onboarding copy' })
		await expect(row).toBeVisible({ timeout: 15_000 })
		await expect(row.getByLabel('Status in review')).toBeVisible()
		await expect(row.getByText('1 new')).toBeVisible()
	})
})

test.describe('Brief drawer — player, listen mode and MENTIONED', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`plays the brief and links the objects it names @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const object = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Cut signup friction',
				content: 'Reduce the number of steps before first value.',
			})
			await mockFeed(page, [])
			await page.route('**/api/briefing*', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						workspace_id: account.workspaceId,
						markdown: `# Your Monday brief\n\nTwo bets need a read.\n\n- **Cut signup friction** [active]\n  id: \`${object.id}\`\n`,
					}),
				})
			})

			await page.goto(`/${account.workspaceId}`)
			await page.getByRole('button', { name: "Today's brief" }).click()

			const drawer = page.getByTestId('brief-drawer')
			await expect(drawer).toBeVisible({ timeout: 15_000 })
			await expect(drawer.getByRole('heading', { name: 'Your Monday brief' })).toBeVisible()

			// The player is only rendered where the browser can actually speak.
			const supported = await page.evaluate(
				() =>
					typeof window.speechSynthesis === 'object' &&
					typeof window.SpeechSynthesisUtterance === 'function',
			)
			if (supported) {
				await expect(drawer.getByTestId('brief-player')).toBeVisible()
				await drawer.getByRole('button', { name: 'Read the brief aloud' }).click()
				await expect(drawer.getByRole('button', { name: 'Listen instead' })).toBeVisible()
				await drawer.getByRole('button', { name: 'Listen instead' }).click()
				await expect(drawer.getByText('Two bets need a read.')).toHaveCount(0)
				await drawer.getByRole('button', { name: 'Read instead' }).click()
			}
			await expect(drawer.getByText('Two bets need a read.')).toBeVisible()

			// MENTIONED resolves the ids the brief prints against real objects.
			await expect(drawer.getByText('Mentioned')).toBeVisible()
			const chip = drawer.getByRole('link', { name: /Cut signup friction/ })
			await expect(chip).toBeVisible()
			await chip.click()
			await expect(page).toHaveURL(new RegExp(`/objects/${object.id}$`))
		})
	}
})

test.describe('Command palette — commands, go to, jump to, search', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`all four groups are reachable @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Palette jump target',
				content: 'Something to jump to.',
			})
			await mockFeed(page, [])
			await page.goto(`/${account.workspaceId}`)
			await expect(page.getByRole('heading', { name: 'For you', level: 1 })).toBeVisible({
				timeout: 15_000,
			})

			await page.keyboard.press('ControlOrMeta+k')
			const input = page.getByPlaceholder('Run a command or jump to…')
			await expect(input).toBeVisible()
			// Scoped to the palette list — the sidebar carries the same view names.
			const list = page.locator('[cmdk-list]')

			// Commands + Go to, with the mockup's right-aligned kind column.
			await expect(list.getByText('New chat')).toBeVisible()
			await expect(list.getByText('Mark all read')).toBeVisible()
			await expect(list.getByText('COMMAND').first()).toBeVisible()
			await expect(list.getByText('Marketplace', { exact: true })).toBeVisible()
			await expect(list.getByText('GO TO').first()).toBeVisible()
			// The retired labels are gone.
			await expect(list.getByText('Bets Dashboard')).toHaveCount(0)
			await expect(list.getByText('All Objects')).toHaveCount(0)

			// Jump to, over the workspace index, plus the terminal search row.
			await input.fill('Palette jump')
			await expect(list.getByText(/Search everything for/)).toBeVisible()
			await expect(
				list.locator('[cmdk-item]').filter({ hasText: 'Palette jump target' }).first(),
			).toBeVisible({ timeout: 15_000 })

			await page.keyboard.press('Escape')
			await page.keyboard.press('Escape')
			await expect(input).toHaveCount(0)
		})
	}

	test('Go to walks to a primary view', async ({ page, account }) => {
		await mockFeed(page, [])
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByRole('heading', { name: 'For you', level: 1 })).toBeVisible({
			timeout: 15_000,
		})

		await page.keyboard.press('ControlOrMeta+k')
		await page.locator('[cmdk-list]').getByText('Loops', { exact: true }).click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/loops$`))
	})
})
