import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { installChatMocks } from '../helpers/chat.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * AC-T8 — the chat Attach button carries a 44 px hit surface via a `::before`
 * pseudo-element without enlarging the visible glyph. Re-opening the
 * PR #1040 regression on the chat surface would ship a customer-visible
 * oversized-icon defect on every mobile breakpoint, so this spec runs at all
 * three ship-gate viewports and pins the visible height tightly — a loose
 * bound (e.g. `≤ 44`) would let a `size="touch"` revert slip past, exactly
 * the NIT flagged on PR #1040's checkbox tap-area spec.
 */

// Design size for the Attach button (`h-7` = 28 px). A `size="sm"` (h-9 = 36),
// `size="default"` (h-10 = 40), or `size="lg"` (h-11 = 44) revert must fail.
const VISIBLE_HEIGHT_PX = 28
const VISIBLE_HEIGHT_TOLERANCE_PX = 4
const TAP_TARGET_MIN_PX = 44

async function openChatAndLocateAttach(page: Page, workspaceId: string) {
	// The header's "Open chat" button is hidden on the For You page (its own
	// header surfaces equivalent actions) — use the Objects list instead.
	await page.goto(`/${workspaceId}/objects`)
	await page.getByRole('button', { name: 'Open chat' }).click()
	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })
	const sheet = page.locator('[data-surface="sheet"]')
	const attach = sheet.getByRole('button', { name: 'Attach image' })
	await expect(attach).toBeVisible({ timeout: 10_000 })
	await expect(attach).toBeEnabled({ timeout: 10_000 })
	return attach
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`Chat Attach button tap area — ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('44 px ::before hit surface with visible glyph unchanged', async ({ page, account }) => {
			await installChatMocks(page, {
				workspaceId: account.workspaceId,
				humanActorId: account.actorId,
				humanActorName: 'E2E Test User',
			})

			const attach = await openChatAndLocateAttach(page, account.workspaceId)

			const measurements = await attach.evaluate((el: HTMLElement) => {
				const rect = el.getBoundingClientRect()
				const before = window.getComputedStyle(el, '::before')
				return {
					visibleHeight: rect.height,
					beforePosition: before.position,
					beforeWidth: Number.parseFloat(before.width),
					beforeHeight: Number.parseFloat(before.height),
					dataSize: el.getAttribute('data-size'),
				}
			})

			// The visible glyph stays at its design height. A tight window on the
			// height (not just an upper bound) blocks a size="touch"-style revert —
			// h-9/h-10/h-11 would all silently enlarge it.
			const heightMessage = `visible height must stay at ~${VISIBLE_HEIGHT_PX} px at ${viewport.label} — a size="touch"-like revert would fail this`
			expect(measurements.visibleHeight, heightMessage).toBeGreaterThanOrEqual(
				VISIBLE_HEIGHT_PX - VISIBLE_HEIGHT_TOLERANCE_PX,
			)
			expect(measurements.visibleHeight, heightMessage).toBeLessThanOrEqual(
				VISIBLE_HEIGHT_PX + VISIBLE_HEIGHT_TOLERANCE_PX,
			)

			// The ::before is not part of layout flow — it must be absolutely
			// positioned so it doesn't affect the composer's toolbar row.
			expect(
				measurements.beforePosition,
				`::before must be absolutely positioned at ${viewport.label}`,
			).toBe('absolute')

			// The hit surface meets WCAG's 44 px target regardless of the visible
			// glyph size.
			expect(
				measurements.beforeWidth,
				`::before width must be ≥ ${TAP_TARGET_MIN_PX} px at ${viewport.label}`,
			).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
			expect(
				measurements.beforeHeight,
				`::before height must be ≥ ${TAP_TARGET_MIN_PX} px at ${viewport.label}`,
			).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)

			// A revert that reintroduces a visible-glyph size variant would ship
			// the exact regression PR #1040 fixed.
			expect(
				measurements.dataSize,
				`Attach button must not expose a visible-glyph size variant at ${viewport.label}`,
			).toBeNull()
		})
	})
}
