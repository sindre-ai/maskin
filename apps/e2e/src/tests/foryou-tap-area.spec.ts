import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// F2: on coarse (touch) pointers each shared-chrome icon button on the For You
// surface must report ≥44×44 CSS pixels. WCAG 2.5.5 Target Size + Maskin 44px
// rule. Fine-pointer (mouse) rendering must stay at the original ~28/32px look.
//
// Covers the three surfaces named in the ticket:
//   - header.tsx: SidebarTrigger, Create new, Open chat
//   - comment-input.tsx: Attach file, Send comment
// The inline Reply button in activity-comment.tsx is covered indirectly — it
// gets the same `pointer-coarse:min-h-11 pointer-coarse:min-w-11` treatment
// but requires seeded comment events to render, so we assert its className
// carries the variant classes in the frontend component test instead.

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
	}
}

function buildItem(workspaceId: string): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: 'bet-foryou-tap-area',
		unread_count: 0,
		mentioning_unread_count: 0,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'bet-foryou-tap-area',
			title: 'Existing bet under test',
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockUnreadThread(page: Page, workspaceId: string) {
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [buildItem(workspaceId)] }),
		})
	})
	await page.route('**/api/events*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events: [] }),
		})
	})
}

async function assertMin44(button: Locator, label: string, viewportLabel: string) {
	await expect(button, `${label} visible @ ${viewportLabel}`).toBeVisible()
	const box = await button.boundingBox()
	if (!box) throw new Error(`boundingBox missing for ${label} @ ${viewportLabel}`)
	expect(box.width, `${label} width ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
	expect(box.height, `${label} height ≥44 @ ${viewportLabel}`).toBeGreaterThanOrEqual(44)
}

test.describe('For You header tap targets — coarse pointer (touch)', () => {
	// hasTouch: true tells Chromium to report `pointer: coarse`, which is what
	// the CSS variant is gated on.
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`header icon buttons are ≥44×44 CSS px @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)

			// Create new + Open chat always render in the header on every viewport.
			await assertMin44(
				page.getByRole('button', { name: 'Create new', exact: true }),
				'Create new',
				viewport.label,
			)
			await assertMin44(
				page.getByRole('button', { name: 'Open chat', exact: true }),
				'Open chat',
				viewport.label,
			)

			// SidebarTrigger only renders below md (<768px) — it collapses into
			// a static sidebar on iPad+ viewports.
			if (viewport.width < 768) {
				await assertMin44(
					page.getByRole('button', { name: 'Toggle Sidebar', exact: true }),
					'SidebarTrigger',
					viewport.label,
				)
			}
		})
	}
})

test.describe('For You comment-input tap targets — coarse pointer (touch)', () => {
	test.use({ hasTouch: true })

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Attach + Send are ≥44×44 CSS px @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockUnreadThread(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('unread-thread-card').first()
			await expect(card).toBeVisible()
			// Activate the persistent reply bar so the CommentInput mounts.
			await card.getByRole('button', { name: 'Reply' }).click()

			await assertMin44(
				page.getByRole('button', { name: 'Attach file', exact: true }),
				'Attach file',
				viewport.label,
			)
			await assertMin44(
				page.getByRole('button', { name: 'Send comment', exact: true }),
				'Send comment',
				viewport.label,
			)
		})
	}
})

test.describe('For You header tap targets — fine pointer (desktop)', () => {
	test('Create new + Open chat stay at ~28px on desktop (fine-pointer rendering unchanged)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		await page.goto(`/${account.workspaceId}`)

		const create = page.getByRole('button', { name: 'Create new', exact: true })
		const chat = page.getByRole('button', { name: 'Open chat', exact: true })
		await expect(create).toBeVisible()
		await expect(chat).toBeVisible()

		const createBox = await create.boundingBox()
		const chatBox = await chat.boundingBox()
		if (!createBox || !chatBox) throw new Error('header buttons missing boundingBox on desktop')

		// The pointer-coarse:min-h-11 variant must NOT apply on a fine pointer:
		// buttons stay at their h-7 w-7 (28px) footprint.
		expect(createBox.height, 'Create new stays <44px on desktop').toBeLessThan(44)
		expect(createBox.width, 'Create new stays <44px on desktop').toBeLessThan(44)
		expect(chatBox.height, 'Open chat stays <44px on desktop').toBeLessThan(44)
		expect(chatBox.width, 'Open chat stays <44px on desktop').toBeLessThan(44)
	})
})
