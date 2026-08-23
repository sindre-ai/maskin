import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// Keyboard reachability + focus containment for the surfaces the bet's
// accessibility criterion specifically calls out: interactive paths reachable
// without a pointer, focus visible on every interactive element, and focus
// correctly trapped in modals and the command palette.

test.describe('keyboard-only interactive paths', () => {
	test.use({
		viewport: { width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height },
	})

	test('the top-level nav is tab-reachable and reports a visible focus ring', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}`)
		// `load` + settle, not `networkidle` — the open SSE connection to
		// /api/events means the network never goes idle (see a11y-routes.spec.ts).
		await page.waitForLoadState('load')
		await page.waitForTimeout(500)

		// Walk a handful of Tab stops and confirm each one lands on a real
		// focusable node with a rendered focus indicator. axe checks static
		// contrast; this asserts the runtime focus outline the token sweep
		// hooks into (--ring / focus-visible utilities).
		let sawFocusableAnchor = false
		let sawFocusableButton = false
		for (let i = 0; i < 20; i++) {
			await page.keyboard.press('Tab')
			const active = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null
				if (!el || el === document.body) return null
				const outline = getComputedStyle(el).outlineStyle
				const boxShadow = getComputedStyle(el).boxShadow
				return {
					tag: el.tagName.toLowerCase(),
					role: el.getAttribute('role'),
					visibleRing: outline !== 'none' || boxShadow !== 'none',
				}
			})
			if (!active) continue
			expect(
				active.visibleRing,
				`Tab stop #${i} (${active.tag}) has no visible focus indicator`,
			).toBe(true)
			if (active.tag === 'a') sawFocusableAnchor = true
			if (active.tag === 'button') sawFocusableButton = true
			if (sawFocusableAnchor && sawFocusableButton) break
		}
		expect(sawFocusableAnchor, 'expected at least one nav anchor to be tab-reachable').toBe(true)
		expect(sawFocusableButton, 'expected at least one header button to be tab-reachable').toBe(true)
	})

	test('the command palette opens with Cmd/Ctrl+K and closes with Escape', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}`)
		// `load` + settle, not `networkidle` — the open SSE connection to
		// /api/events means the network never goes idle (see a11y-routes.spec.ts).
		await page.waitForLoadState('load')
		await page.waitForTimeout(500)

		await page.keyboard.press('ControlOrMeta+k')
		const palette = page.getByPlaceholder('Search objects, navigate...')
		await expect(palette).toBeVisible()
		await expect(palette).toBeFocused()

		await page.keyboard.press('Escape')
		await expect(palette).toHaveCount(0)
	})

	test('opening the palette does not let Tab escape back into the page', async ({
		page,
		account,
	}) => {
		// Focus containment inside the command palette. Regression guard for the
		// current implementation which mounts cmdk in a plain overlay rather than
		// a Radix Dialog — if the trap is broken, Tab will jump to a page-level
		// button and the focused element will no longer be inside the palette
		// tree. Owning fix goes on the app-shell bet; this spec fails if the
		// containment ever regresses further.
		await page.goto(`/${account.workspaceId}`)
		// `load` + settle, not `networkidle` — the open SSE connection to
		// /api/events means the network never goes idle (see a11y-routes.spec.ts).
		await page.waitForLoadState('load')
		await page.waitForTimeout(500)

		await page.keyboard.press('ControlOrMeta+k')
		const palette = page.getByPlaceholder('Search objects, navigate...')
		await expect(palette).toBeVisible()

		for (let i = 0; i < 8; i++) {
			await page.keyboard.press('Tab')
			const escaped = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement | null
				if (!el || el === document.body) return true
				return !el.closest('[cmdk-root]')
			})
			expect(escaped, `Tab #${i + 1} escaped the palette focus scope`).toBe(false)
		}

		await page.keyboard.press('Escape')
	})
})
