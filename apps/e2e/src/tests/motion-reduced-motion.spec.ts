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

async function probeReducedMotion(page: import('@playwright/test').Page) {
	// Inject a fresh element with a long transition + animation duration and
	// read what the browser actually resolves after applying every rule that
	// matches. Under the reduced-motion guard both should collapse to 0.01ms.
	return page.evaluate(() => {
		const el = document.createElement('div')
		el.className = 'transition-all duration-1000 animate-spin'
		el.style.animationDuration = '5s'
		el.style.transitionDuration = '5s'
		document.body.appendChild(el)
		const cs = getComputedStyle(el)
		const result = {
			transition: cs.transitionDuration,
			animation: cs.animationDuration,
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

			// Baseline: no-preference — the injected transition should run at its
			// declared duration, not the collapsed value. Confirms the probe
			// itself is meaningful (not always-zero).
			await page.emulateMedia({ reducedMotion: 'no-preference' })
			await page.goto(path)
			await page.waitForLoadState('networkidle')
			await expect(page.locator('body')).toBeVisible()

			const baseline = await probeReducedMotion(page)
			expect(baseline.transition).toBe('5s')
			expect(baseline.animation).toBe('5s')

			// Then flip the media query and reprobe. The base-layer @media rule
			// in app.css must clamp both durations to 0.01ms (disabled, not
			// slowed) via !important, which wins over the inline styles above.
			await page.emulateMedia({ reducedMotion: 'reduce' })
			const reduced = await probeReducedMotion(page)
			expect(reduced.transition).toBe('0.01ms')
			expect(reduced.animation).toBe('0.01ms')
		})
	}
})
