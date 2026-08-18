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
		path: () => '/login',
	},
	{
		label: 'signup',
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
		path: (ctx) => `/${ctx.workspaceId}/loops`,
	},
	{
		label: 'triggers index',
		path: (ctx) => `/${ctx.workspaceId}/triggers`,
	},
	{
		label: 'marketplace index',
		path: (ctx) => `/${ctx.workspaceId}/marketplace`,
	},
	{
		label: 'briefing',
		path: (ctx) => `/${ctx.workspaceId}/briefing`,
	},
	{
		label: 'settings index',
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
				// Give React a beat to paint the first interactive state so the
				// scan doesn't fire against an empty root before hydration lands.
				await page.waitForLoadState('networkidle')
				await expect(page.locator('body')).toBeVisible()

				await expectNoSeriousA11yViolations(page, `${route.label} · ${theme}`, {
					disableRules: route.disableRules,
				})
			})
		}
	}
})
