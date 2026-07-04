import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for the ChatPinShell push/collapse mechanic.
 *
 * The refactored ChatPinShell (PR #982) replaces the old `transition-[margin]`
 * with a CSS Grid `grid-template-columns` animation. Vitest covers every render
 * state and a negative assertion locking out `transition-[margin]`, but
 * browser-level verification of the animated push, reduced-motion, and resize
 * behavior could not run in the original session (Playwright MCP WS returned
 * 404). This spec closes that gap.
 */

async function getShellGridColumns(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="chat-pin-shell"]')
		if (!el) return null
		return window.getComputedStyle(el).gridTemplateColumns
	})
}

async function getShellTransitionDuration(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="chat-pin-shell"]')
		if (!el) return null
		return window.getComputedStyle(el).transitionDuration
	})
}

test.describe('ChatPinShell — pin/unpin cycle', () => {
	test('desktop: pinning reserves a right column, unpinning collapses it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto(`/${account.workspaceId}`)
		await page.waitForLoadState('load')

		// Open the chat panel
		await page.getByRole('button', { name: 'Open chat' }).click()
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })

		// Before pinning, the second column should be 0px
		const unpinned = await getShellGridColumns(page)
		expect(unpinned).toMatch(/minmax\(0,1fr\) 0px/)

		// Pin the sidebar — the pin toggle is only rendered on desktop
		await page.getByRole('button', { name: 'Pin sidebar' }).click()

		// The second column now reserves space for the chat panel (default width 448px)
		const pinned = await getShellGridColumns(page)
		expect(pinned).toMatch(/minmax\(0,1fr\) [1-9]/)

		// Unpin — second column collapses back to 0px
		await page.getByRole('button', { name: 'Unpin sidebar' }).click()
		const afterUnpin = await getShellGridColumns(page)
		expect(afterUnpin).toMatch(/minmax\(0,1fr\) 0px/)
	})

	test('mobile: panel overlays without pushing main content', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})

		// On mobile the PinToggle is hidden (isMobile guard), so set pinned via
		// localStorage before navigation to simulate the cross-workspace preference.
		await page.addInitScript(() => {
			localStorage.setItem('maskin-chat-pinned', 'true')
		})

		await page.goto(`/${account.workspaceId}`)
		await page.waitForLoadState('load')

		// Open the chat panel
		await page.getByRole('button', { name: 'Open chat' }).click()
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10_000 })

		// Even with pinned=true, the !isMobile guard in ChatPinShell keeps the
		// second column at 0px — the panel overlays without pushing.
		const gridCols = await getShellGridColumns(page)
		expect(gridCols).toMatch(/minmax\(0,1fr\) 0px/)
	})

	test('reduced-motion clamps transition-duration to 0.01ms', async ({ page, account }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto(`/${account.workspaceId}`)
		await page.waitForLoadState('load')

		const duration = await getShellTransitionDuration(page)
		// The global @media (prefers-reduced-motion: reduce) rule in app.css
		// clamps all transition-durations to 0.01ms.
		expect(duration).toBe('0.01ms')
	})
})
