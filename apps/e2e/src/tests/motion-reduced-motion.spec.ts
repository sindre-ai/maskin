import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// Walks the same 14-route canon as `a11y-routes.spec.ts` and asserts that
// with `prefers-reduced-motion: reduce` emulated, the global `@layer base`
// guard in `apps/web/src/app.css` collapses transition-duration and
// animation-duration to ~0 on every rendered element. We probe with a
// disposable element we inject into the live DOM — that keeps the assertion
// robust to which surfaces happen to render an animation on which route,
// while still being a real check that the media query is being applied by
// the browser (not just present in the CSS text).

interface RouteSpec {
	label: string
	path: (ctx: { workspaceId: string }) => string
}

const ROUTES: RouteSpec[] = [
	{ label: 'login', path: () => '/login' },
	{ label: 'signup', path: () => '/signup' },
	{ label: 'workspace picker', path: () => '/workspaces' },
	{ label: 'for-you', path: (ctx) => `/${ctx.workspaceId}` },
	{ label: 'objects index', path: (ctx) => `/${ctx.workspaceId}/objects` },
	{ label: 'agents index', path: (ctx) => `/${ctx.workspaceId}/agents` },
	{ label: 'loops index', path: (ctx) => `/${ctx.workspaceId}/loops` },
	{ label: 'triggers index', path: (ctx) => `/${ctx.workspaceId}/triggers` },
	{ label: 'marketplace index', path: (ctx) => `/${ctx.workspaceId}/marketplace` },
	{ label: 'briefing', path: (ctx) => `/${ctx.workspaceId}/briefing` },
	{ label: 'settings index', path: (ctx) => `/${ctx.workspaceId}/settings` },
	{ label: 'settings integrations', path: (ctx) => `/${ctx.workspaceId}/settings/integrations` },
	{ label: 'settings members', path: (ctx) => `/${ctx.workspaceId}/settings/members` },
	{ label: 'settings skills', path: (ctx) => `/${ctx.workspaceId}/settings/skills` },
]

/** Returns computed transition/animation durations as numbers in milliseconds.
 *  Chromium normalises short time values to seconds in getComputedStyle (e.g.
 *  0.001ms → '0.000001s'), so comparing raw strings is fragile. Parse here
 *  and let callers use numeric comparisons instead. */
async function probeReducedMotionMs(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const el = document.createElement('div')
		el.className = 'transition-all duration-1000 animate-spin'
		el.style.animationDuration = '5s'
		el.style.transitionDuration = '5s'
		document.body.appendChild(el)
		const cs = getComputedStyle(el)
		const parseMs = (v: string): number => {
			if (!v || v === '0s' || v === '0ms') return 0
			if (v.endsWith('ms')) return Number.parseFloat(v)
			if (v.endsWith('s')) return Number.parseFloat(v) * 1000
			return 0
		}
		const result = {
			transitionMs: parseMs(cs.transitionDuration),
			animationMs: parseMs(cs.animationDuration),
		}
		el.remove()
		return result
	})
}

test.describe('motion — prefers-reduced-motion guard', () => {
	test.use({ viewport: { width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height } })

	for (const route of ROUTES) {
		test(`${route.label} — motion collapses under reduce`, async ({ page, account }) => {
			await page.addInitScript(() => {
				localStorage.setItem('maskin-theme', 'light')
			})

			const path = route.path({ workspaceId: account.workspaceId })

			// Baseline: no-preference — the injected inline style (5s) should win
			// over the Tailwind class (1s), confirming the probe is meaningful and
			// not always-zero.
			await page.emulateMedia({ reducedMotion: 'no-preference' })
			await page.goto(path)
			await page.waitForLoadState('load')
			// SSE keeps a connection open indefinitely, so 'networkidle' never fires — see
			// the same pattern in visual.spec.ts / typography.spec.ts.
			await page.waitForTimeout(300)
			await expect(page.locator('body')).toBeVisible()

			const baseline = await probeReducedMotionMs(page)
			expect(baseline.transitionMs).toBeGreaterThan(4000) // inline 5s wins
			expect(baseline.animationMs).toBeGreaterThan(4000)

			// Flip the media query and reprobe. The @layer base @media rule sets
			// both durations to 0.001ms via !important, which wins over inline
			// styles. 0.001ms is < 1ms, so motion is effectively disabled.
			await page.emulateMedia({ reducedMotion: 'reduce' })
			const reduced = await probeReducedMotionMs(page)
			expect(reduced.transitionMs).toBeLessThan(1) // 0.001ms << 1ms
			expect(reduced.animationMs).toBeLessThan(1)
		})
	}
})
