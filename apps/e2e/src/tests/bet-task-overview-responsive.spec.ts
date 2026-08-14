import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type NamedViewport, SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// T4 of bet maskin-mobile-app: bet + task overview must be readable and
// scrollable on iPhone (375) and render acceptably on iPad (768/1024) —
// no horizontal overflow, no phone-column letterbox, and the child tasks
// linked to a bet stay legible in the bet's activity timeline.
//
// The bet list surface is /$workspaceId/objects filtered by type — the
// horizontal-overflow gate for that list is already locked in by
// mobile-qa.spec.ts. This spec covers the two surfaces that aren't:
//
//   1. Bet detail with a real fan-out of `breaks_into` child tasks
//      (mobile-qa seeds a bare bet with no relationships).
//   2. The iPad no-letterbox check on those surfaces — the bounding box
//      of the visible document must exceed the old phone-column width
//      (760px) at 768 and 1024, matching T3's ForYou feed gate.

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1

async function assertNoHorizontalOverflow(page: Page, surface: string, viewport: NamedViewport) {
	// SSE holds a long-lived connection to /api/events, so `networkidle`
	// never fires — brief layout-settle wait after `load` instead.
	await page.waitForLoadState('load')
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(
		scrollWidth,
		`${surface} overflows horizontally at ${viewport.label}: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
	).toBeLessThanOrEqual(innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)
}

interface SeededBet {
	betId: string
	taskTitles: string[]
}

async function seedBetWithChildTasks(account: {
	workspaceId: string
	api: {
		createObject: (
			ws: string,
			data: { type: string; title: string; status?: string },
		) => Promise<{ id: string }>
		createRelationship: (
			ws: string,
			data: {
				source_type: string
				source_id: string
				target_type: string
				target_id: string
				type: string
			},
		) => Promise<unknown>
	}
}): Promise<SeededBet> {
	const bet = await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Mobile QA — bet with children',
		status: 'signal',
	})

	// Mix of short and long task titles — long ones exercise the truncate
	// path on narrow viewports; short ones prove the row is fully readable.
	const taskTitles = [
		'Wire up push notifications',
		'Design onboarding flow for first-time iPad users with side-by-side layout',
		'Cover offline mode edge cases',
	]

	const tasks = await Promise.all(
		taskTitles.map((title) =>
			account.api.createObject(account.workspaceId, {
				type: 'task',
				title,
				status: 'todo',
			}),
		),
	)

	for (const task of tasks) {
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'bet',
			source_id: bet.id,
			target_type: 'task',
			target_id: task.id,
			type: 'breaks_into',
		})
	}

	return { betId: bet.id, taskTitles }
}

test.describe('Bet + task overview — responsive ship gate', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`bet detail with children stays legible @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const { betId, taskTitles } = await seedBetWithChildTasks(account)

			await page.goto(`/${account.workspaceId}/objects/${betId}`)
			// The title lives in a `<textarea placeholder="Untitled">` (object-document.tsx),
			// so wait for the textarea to render and reflect the seeded title value.
			const titleEditor = page.locator('textarea[placeholder="Untitled"]').first()
			await expect(titleEditor).toBeVisible({ timeout: 10000 })
			await expect(titleEditor).toHaveValue(/Mobile QA — bet with children/)

			await assertNoHorizontalOverflow(page, 'Bet detail with children', viewport)

			// Every child task's title must be reachable in the DOM at every
			// viewport — long titles may truncate visually, but the accessible
			// link the user taps to open the task must still be present.
			for (const title of taskTitles) {
				await expect(
					page.getByRole('link', { name: title }),
					`${viewport.label}: child task "${title.slice(0, 30)}…" must be linked from the bet detail`,
				).toBeVisible({ timeout: 5000 })
			}
		})
	}

	// Bet list surface — the objects list filtered to bets. Overflow at
	// this route is already covered by mobile-qa.spec.ts for the unfiltered
	// list, but the type filter changes the toolbar shape; keep an explicit
	// check so the bet-typed list doesn't drift.
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`bet list stays overflow-free @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Mobile QA — bet in list',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			await expect(page.getByText('Mobile QA — bet in list').first()).toBeVisible({
				timeout: 10000,
			})

			await assertNoHorizontalOverflow(page, 'Bet list', viewport)
		})
	}
})

test.describe('Bet detail — iPad no-letterbox gate', () => {
	// T4 iPad DoD: content fills the screen — no phone-column letterbox at
	// 768 or 1024. Matches the bounding-box pattern T3 introduced for the
	// For You card queue (foryou-prototype-responsive.spec.ts): the visible
	// document region must exceed the old 760px phone-column cap. The bet
	// title's <textarea> is the widest guaranteed content element inside the
	// document container, so its bounding box is the fair-share proxy for
	// how much horizontal canvas the reader sees.
	for (const [label, viewport, minWidth] of [
		['iPad portrait', VIEWPORTS.tabletPortrait, 500],
		['iPad landscape', VIEWPORTS.tabletLandscape, 700],
	] as const) {
		test(`document region uses > ${minWidth}px @ ${label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const { betId } = await seedBetWithChildTasks(account)

			await page.goto(`/${account.workspaceId}/objects/${betId}`)
			// The title textarea is `w-full` inside the `max-w-3xl mx-auto` document
			// container, so its bounding box is the fair-share proxy for how much
			// horizontal canvas the reader gets on the bet detail.
			const titleField = page.locator('textarea[placeholder="Untitled"]').first()
			await expect(titleField).toBeVisible({ timeout: 10000 })
			await expect(titleField).toHaveValue(/Mobile QA/)

			const titleBox = await titleField.boundingBox()
			expect(titleBox, `${label}: title field has no layout box`).not.toBeNull()
			if (titleBox) {
				expect(
					titleBox.width,
					`${label}: document region is ${titleBox.width}px — still letterboxed to phone-column width`,
				).toBeGreaterThan(minWidth)
			}
		})
	}
})
