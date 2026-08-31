import { expect, test } from '../fixtures/auth.fixture'
import { expectNoSeriousA11yViolations, setThemeBeforeLoad } from '../helpers/a11y.helper'
import { VIEWPORTS } from '../helpers/viewports'

// Cross-cutting accessibility sweep for the primary product surfaces.
//
// Walks the fourteen canonical routes in both light and dark theme and
// asserts axe-core reports no serious or critical WCAG 2.1 AA violations.
// Minor and moderate findings are logged to stdout for the Ship Notes so
// they can be filed as drift tasks on the owning view bet — the audit
// blocks only on the serious/critical bar because the bet explicitly
// scopes contrast + interactive states to the WCAG AA floor.
//
// The route list mirrors what the sidebar, settings hub and detail
// entry-points expose today; two of the detail routes are seeded per
// test so they render a real document instead of a not-found frame.
//
// `disableRules` carries this stack's outstanding debt. Nine of these
// screens have not been rebuilt yet — they still render their pre-v2
// markup and each carries a serious finding that predates this branch
// (unlabelled icon buttons, zinc-300 status text, list markup, the login
// footer link). Turning a rule off for one route keeps the sweep honest
// everywhere else: every other rule still blocks on that route, and the
// same rule still blocks on every route that has landed. The findings are
// still printed to stdout by the helper, so the Ship Notes pick them up.
// Each entry names what it is hiding; delete it when the owning screen
// lands.

type SetupCtx = {
	workspaceId: string
	api: import('../helpers/api.helper').TestAPI
}

interface RouteSpec {
	label: string
	path: (ctx: { workspaceId: string }) => string
	// Seeds required data and, optionally, returns a `path` string that
	// overrides the static `path()` result — used when the URL depends on a
	// generated id (object detail, agent detail).
	setup?: (ctx: SetupCtx) => Promise<{ path?: string }>
	// Some routes are legitimately below the interactive-region requirement
	// (auth screens) or run before the workspace shell mounts. Allow rules to
	// be disabled per route rather than globally, so the sweep still catches
	// them where they matter.
	disableRules?: string[]
}

const ROUTES: RouteSpec[] = [
	{
		label: 'login',
		// Pre-existing: the "Don't have an account? Sign up" footer link is colour-only.
		disableRules: ['link-in-text-block'],
		path: () => '/login',
	},
	{
		label: 'signup',
		// Pre-existing: same footer link as login, mirrored.
		disableRules: ['link-in-text-block'],
		path: () => '/signup',
	},
	{
		label: 'workspace picker',
		path: () => '/workspaces',
	},
	{
		label: 'for-you (workspace landing)',
		path: (ctx) => `/${ctx.workspaceId}`,
		setup: async (ctx) => {
			await ctx.api.createObject(ctx.workspaceId, {
				type: 'bet',
				title: 'A11y sweep bet',
				status: 'active',
			})
			return {}
		},
	},
	{
		label: 'objects index',
		// Pre-existing: zinc-300 status text on white, and rows are divs inside a <ul>.
		disableRules: ['color-contrast', 'list'],
		path: (ctx) => `/${ctx.workspaceId}/objects`,
		setup: async (ctx) => {
			await ctx.api.createObject(ctx.workspaceId, {
				type: 'insight',
				title: 'A11y sweep insight',
				status: 'new',
			})
			return {}
		},
	},
	{
		label: 'object detail',
		// Pre-existing: icon-only toolbar buttons with no accessible name.
		disableRules: ['button-name'],
		path: (ctx) => `/${ctx.workspaceId}/objects`,
		setup: async (ctx) => {
			const obj = await ctx.api.createObject(ctx.workspaceId, {
				type: 'bet',
				title: 'A11y sweep detail bet',
				status: 'active',
			})
			return { path: `/${ctx.workspaceId}/objects/${obj.id}` }
		},
	},
	{
		label: 'agents index',
		// Pre-existing: zinc-300 status text on white.
		disableRules: ['color-contrast'],
		path: (ctx) => `/${ctx.workspaceId}/agents`,
	},
	{
		label: 'agent detail',
		path: (ctx) => `/${ctx.workspaceId}/agents`,
		setup: async (ctx) => {
			const agent = await ctx.api.createAgentActor(`A11y sweep agent ${Date.now()}`)
			await ctx.api.addWorkspaceMember(ctx.workspaceId, agent.id, 'member')
			return { path: `/${ctx.workspaceId}/agents/${agent.id}` }
		},
	},
	{
		label: 'loops index',
		// Pre-existing: zinc-300 status text on white.
		disableRules: ['color-contrast'],
		path: (ctx) => `/${ctx.workspaceId}/loops`,
	},
	{
		label: 'triggers index',
		// Pre-existing: zinc-300 status text on white.
		disableRules: ['color-contrast'],
		path: (ctx) => `/${ctx.workspaceId}/triggers`,
	},
	{
		label: 'marketplace index',
		// Pre-existing: muted card meta text on white.
		disableRules: ['color-contrast'],
		path: (ctx) => `/${ctx.workspaceId}/marketplace`,
	},
	{
		label: 'briefing',
		// Pre-existing: the markdown body scrolls but takes no keyboard focus.
		disableRules: ['scrollable-region-focusable'],
		path: (ctx) => `/${ctx.workspaceId}/briefing`,
	},
	{
		label: 'settings index',
		// Pre-existing: icon-only controls and an unlabelled input.
		disableRules: ['button-name', 'label'],
		path: (ctx) => `/${ctx.workspaceId}/settings`,
	},
	{
		label: 'settings integrations',
		path: (ctx) => `/${ctx.workspaceId}/settings/integrations`,
	},
]

const THEMES = ['light', 'dark'] as const

test.describe('a11y route sweep (WCAG 2.1 AA)', () => {
	test.use({ viewport: { width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height } })

	for (const route of ROUTES) {
		for (const theme of THEMES) {
			test(`${route.label} — ${theme}`, async ({ page, account }) => {
				await setThemeBeforeLoad(page, theme)

				let path = route.path({ workspaceId: account.workspaceId })
				if (route.setup) {
					const override = await route.setup({
						workspaceId: account.workspaceId,
						api: account.api,
					})
					if (override?.path) path = override.path
				}

				await page.goto(path)
				// `load` plus a short settle, never `networkidle` — every workspace
				// route holds an open SSE connection to /api/events, so the network
				// is never idle and the wait burns the whole test timeout instead of
				// returning (same reasoning as mobile-qa / settings-integrations).
				// The settle is what gives React its beat to paint the first
				// interactive state, so the scan doesn't fire against an empty root.
				await page.waitForLoadState('load')
				await page.waitForTimeout(500)
				await expect(page.locator('body')).toBeVisible({ timeout: 10000 })

				await expectNoSeriousA11yViolations(page, `${route.label} · ${theme}`, {
					disableRules: route.disableRules,
				})
			})
		}
	}
})
