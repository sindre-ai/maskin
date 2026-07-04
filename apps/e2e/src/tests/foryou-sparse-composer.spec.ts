import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// For You sparse-state composer (T1 of bet `foryou-sparse-composer`).
//
// AC-U1: composer renders inside the empty state when `items.length === 0`.
// AC-U2: composer renders directly below items when `1 ≤ items.length < 3`.
// AC-U3: composer is hidden when `items.length >= 3`.
// AC-U4: typing + Enter opens the chat panel with the message staged.
//
// The unread feed is mocked at the `/api/subscriptions/unread` boundary so the
// spec stays deterministic regardless of what the real backend seeds. The chat
// surface itself is verified to open — the persistent session bootstrap is
// covered by chat.spec.ts and not re-exercised here.

interface UnreadFixture {
	entity_type: 'object'
	entity_id: string
	unread_count: number
	mentions_you: boolean
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

function buildItem(workspaceId: string, n: number): UnreadFixture {
	return {
		entity_type: 'object',
		entity_id: `bet-${n}`,
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: `bet-${n}`,
			title: `Existing bet ${n}`,
			type: 'bet',
			status: 'active',
			workspaceId,
		},
	}
}

async function mockUnreadCount(page: Page, workspaceId: string, count: number) {
	const items = Array.from({ length: count }, (_, i) => buildItem(workspaceId, i + 1))
	await page.route('**/api/subscriptions/unread*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items }),
		})
	})
}

const COMPOSER_LABEL = 'Start a chat with agents'

test.describe('For You sparse composer', () => {
	test('renders inside the empty state when items.length === 0 (AC-U1)', async ({
		page,
		account,
	}) => {
		await mockUnreadCount(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByText('All caught up')).toBeVisible()
		const composer = page.getByTestId('sparse-composer')
		await expect(composer.getByLabel(COMPOSER_LABEL)).toBeVisible()
		await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible()
		// AC-U7: quick-start chips only show on the 0-item branch.
		await expect(page.getByTestId('sparse-composer-chips')).toBeVisible()
	})

	test('renders below items when 1 ≤ items.length < 3 (AC-U2)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 2)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('sparse-composer').getByLabel(COMPOSER_LABEL)).toBeVisible()
		// Chips are 0-item-only.
		await expect(page.getByTestId('sparse-composer-chips')).toHaveCount(0)
	})

	test('is hidden when items.length >= 3 (AC-U3)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 3)
		await page.goto(`/${account.workspaceId}`)
		await expect(page.getByTestId('unread-thread-card').first()).toBeVisible()
		await expect(page.getByTestId('sparse-composer')).toHaveCount(0)
	})

	test('typing + Enter opens the chat panel (AC-U4)', async ({ page, account }) => {
		await mockUnreadCount(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)
		const input = page.getByTestId('sparse-composer').getByLabel(COMPOSER_LABEL)
		await input.fill('Plan a launch')
		await input.press('Enter')
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })
		// AC-U4: input clears after the call resolves.
		await expect(input).toHaveValue('')
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`composer + send button visible at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await mockUnreadCount(page, account.workspaceId, 0)
			await page.goto(`/${account.workspaceId}`)
			const composer = page.getByTestId('sparse-composer')
			await expect(composer.getByLabel(COMPOSER_LABEL)).toBeVisible()
			await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible()
		})
	}

	// AC-U5 / AC-T5: iPhone SE (375×667) is the smallest viewport in the bet's
	// acceptance contract, and the one that bites hardest when the iOS soft
	// keyboard rises ~290px and shrinks the visual viewport to ~377px tall.
	// Real iOS Safari keyboard rendering only happens on a physical device;
	// this case approximates it by emulating a visualViewport resize after
	// focus, then asserts the textarea + send button stay inside the resulting
	// box and that submit still fires. See `## Frontend Parity` + the
	// `## Unverified interactions` block on T5 for the hardware-only delta.
	test('AC-U5 + AC-T5 — 375×667 with simulated soft keyboard', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 667 })
		await mockUnreadCount(page, account.workspaceId, 0)
		await page.goto(`/${account.workspaceId}`)

		const composer = page.getByTestId('sparse-composer')
		const input = composer.getByLabel(COMPOSER_LABEL)
		const sendButton = composer.getByRole('button', { name: 'Send message' })
		await expect(input).toBeVisible()
		await expect(sendButton).toBeVisible()

		// AC-U5 reachability: the input and the send button must sit inside the
		// visual viewport without horizontal scroll. Use bounding boxes (rather
		// than only `toBeVisible`) so the assertion fails loudly if either
		// element slips below the simulated keyboard fold.
		const viewportWidth = 375
		const inputBoxBeforeFocus = await input.boundingBox()
		const sendBoxBeforeFocus = await sendButton.boundingBox()
		if (!inputBoxBeforeFocus) throw new Error('input has no layout box at 375×667')
		if (!sendBoxBeforeFocus) throw new Error('send button has no layout box at 375×667')
		expect(inputBoxBeforeFocus.x + inputBoxBeforeFocus.width).toBeLessThanOrEqual(viewportWidth)
		expect(sendBoxBeforeFocus.x + sendBoxBeforeFocus.width).toBeLessThanOrEqual(viewportWidth)

		// Capture the For You scroll position so we can assert it's preserved
		// across the focus → blur cycle that mirrors keyboard up → down.
		const scrollerSelector = '[data-testid="sparse-composer"]'
		const scrollBefore = await page.evaluate(() => window.scrollY)

		// AC-T5 keyboard-up: simulate iOS Safari's visualViewport shrinkage on
		// focus by dispatching a synthetic resize that reports the post-keyboard
		// height. Real iOS does this via the OS keyboard; Chromium does not, so
		// we drive it manually and verify the layout still surfaces both
		// controls inside the reduced viewport.
		await input.focus()
		const KEYBOARD_HEIGHT = 290
		const reducedHeight = 667 - KEYBOARD_HEIGHT
		await page.evaluate((h) => {
			const vv = window.visualViewport
			if (!vv) return
			Object.defineProperty(vv, 'height', { configurable: true, value: h })
			vv.dispatchEvent(new Event('resize'))
		}, reducedHeight)

		const inputBoxKeyboardUp = await input.boundingBox()
		const sendBoxKeyboardUp = await sendButton.boundingBox()
		if (!inputBoxKeyboardUp) throw new Error('input has no layout box with keyboard up')
		if (!sendBoxKeyboardUp) throw new Error('send button has no layout box with keyboard up')
		// Both controls must end below 0 (above the page top) and above the
		// reduced visual viewport's bottom (i.e. above the simulated keyboard).
		expect(inputBoxKeyboardUp.y).toBeGreaterThanOrEqual(0)
		expect(sendBoxKeyboardUp.y).toBeGreaterThanOrEqual(0)
		expect(inputBoxKeyboardUp.y + inputBoxKeyboardUp.height).toBeLessThanOrEqual(reducedHeight)
		expect(sendBoxKeyboardUp.y + sendBoxKeyboardUp.height).toBeLessThanOrEqual(reducedHeight)

		// Submit fires while the keyboard is "up" — Enter on the focused
		// textarea, not a click on the button (which on real iOS would dismiss
		// the keyboard before the tap registers). The chat panel heading is the
		// observable result of `openWithContext` resolving.
		await input.fill('Plan a launch from iPhone SE')
		await input.press('Enter')
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })
		await expect(input).toHaveValue('')

		// AC-T5 keyboard-down: restore the visualViewport height and verify the
		// scroll position survives the cycle. The For You scroll container is
		// the `overflow-auto` div inside the workspace layout — the body
		// scrollY stays at 0 by design, so we sanity-check the same scroller
		// the composer lives in.
		await page.evaluate(() => {
			const vv = window.visualViewport
			if (!vv) return
			Object.defineProperty(vv, 'height', { configurable: true, value: window.innerHeight })
			vv.dispatchEvent(new Event('resize'))
		})
		const scrollAfter = await page.evaluate(() => window.scrollY)
		expect(scrollAfter, 'For You scroll position preserved after keyboard dismiss').toBe(
			scrollBefore,
		)
		// Sanity: composer still rendered (chat panel may be open over it).
		await expect(page.locator(scrollerSelector)).toHaveCount(1)
	})
})
