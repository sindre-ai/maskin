import { NavSearch } from '@/components/layout/nav-search'
import { NewMenu, type PrimaryKind } from '@/components/shared/new-menu'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { isHiddenRouteId } from '@/lib/nav-view-keys'
import { usePageHeader } from '@/lib/page-header-context'
import { useWorkspace } from '@/lib/workspace-context'
import { useMatches, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Fragment } from 'react'

interface RouteConfig {
	label: string
	parent?: string
	// Which create action the split New button's label half runs on this screen
	// (mockup `newPrimary`). Screens that create nothing in particular fall
	// through to a new chat.
	primary?: PrimaryKind
}

const routeConfig: Record<string, RouteConfig> = {
	'/_authed/$workspaceId/': { label: 'For you' },
	'/_authed/$workspaceId/search': { label: 'Search' },
	'/_authed/$workspaceId/objects/': { label: 'Objects', primary: 'object' },
	'/_authed/$workspaceId/objects/$objectId': {
		label: 'Object Details',
		parent: '/_authed/$workspaceId/objects/',
		primary: 'object',
	},
	'/_authed/$workspaceId/agents/': { label: 'Agents', primary: 'agent' },
	// Triggers keeps its own list route (deep links and bookmarks still resolve)
	// even though the v2 nav reaches triggers through Loops. Without an entry
	// here the screen renders with no title at all.
	//
	// Screens that render their own heading in the page body (Briefing, Chats'
	// conversation list, the new-chat composer) are deliberately absent — an
	// entry here would put a second heading of the same name in the nav row.
	'/_authed/$workspaceId/triggers/': { label: 'Triggers', primary: 'loop' },
	'/_authed/$workspaceId/settings/skills': {
		label: 'Skills',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/': { label: 'Settings' },
	// "Keys", not "Billing": v2 moved billing to its own route below, and this
	// static map has no flag access, so a shared label would leave two routes
	// claiming the same crumb. Under the pre-v2 nav this page is still labelled
	// "Billing" in the sidebar — the crumb names the page's contents instead.
	'/_authed/$workspaceId/settings/keys': {
		label: 'Keys',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/members': {
		label: 'Members',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/integrations': {
		label: 'Integrations',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/extensions': {
		label: 'Extensions',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/billing': {
		label: 'Billing',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/mcp': {
		label: 'MCP',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/objects/': {
		label: 'Objects',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/objects/$propertyName': {
		label: 'Property Details',
		parent: '/_authed/$workspaceId/settings/objects/',
	},
	// `/triggers` redirects to `/loops` in v2, so trigger detail hangs off Loops
	// — a "Triggers" crumb would link to a page that bounces.
	'/_authed/$workspaceId/triggers/$triggerId': {
		label: 'Trigger Details',
		parent: '/_authed/$workspaceId/loops/',
		primary: 'loop',
	},
	// The mockup (1584) shows a middle crumb — `Loops › Not tied to a loop › name`
	// — but that middle term is the trigger's owning loop, or the literal
	// "Not tied to a loop" only when it has none. Crumbs here are derived from the
	// route, which cannot know either. A hardcoded middle crumb would be wrong on
	// every loop-owned trigger, so the chain stays `Loops › name`. Restoring it
	// means letting the page publish its own crumb, since only it has the loop.
	'/_authed/$workspaceId/loops/': { label: 'Loops', primary: 'loop' },
	'/_authed/$workspaceId/loops/new': {
		label: 'New loop',
		parent: '/_authed/$workspaceId/loops/',
		primary: 'loop',
	},
	'/_authed/$workspaceId/loops/$loopId': {
		label: 'Loop Details',
		parent: '/_authed/$workspaceId/loops/',
		primary: 'loop',
	},
	'/_authed/$workspaceId/marketplace/': { label: 'Marketplace' },
	'/_authed/$workspaceId/marketplace/$loopId/': {
		label: 'Marketplace Item',
		parent: '/_authed/$workspaceId/marketplace/',
	},
	'/_authed/$workspaceId/marketplace/$loopId/$itemId': {
		label: 'Marketplace Item',
		parent: '/_authed/$workspaceId/marketplace/$loopId/',
	},
}

const OBJECT_DETAIL_ROUTE_ID = '/_authed/$workspaceId/objects/$objectId'

/**
 * The shared top nav — mockup lines 155–279.
 *
 * One 44px row per screen: the screen's <h1> and muted count on the left, then
 * the workspace search, the screen's own actions, a hairline divider, and the
 * split New button. It wraps rather than scrolls, so a narrow viewport drops the
 * right-hand cluster to a second line instead of hiding controls.
 *
 * The title resolves in three steps: a `stickyIdentity` the page supplied wins
 * (it is a richer identity element than a string), then the page's `title`, then
 * the route's own label. Detail routes keep a breadcrumb chain until their
 * screen lands and moves it into the page body, which is where v2 puts it.
 */
export function Header() {
	const matches = useMatches()
	const { title, subtitle, actions, stickyIdentity } = usePageHeader()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const router = useRouter()

	// Find the leaf (last non-hidden) match
	const leafMatch = [...matches].reverse().find((m) => !isHiddenRouteId(m.routeId))
	const leafConfig = leafMatch ? routeConfig[leafMatch.routeId] : undefined

	// Build crumb chain by walking parent references
	const crumbs: { label: string; path: string }[] = []
	if (leafMatch && leafConfig) {
		// Add parent crumbs first
		let parentId = leafConfig.parent
		while (parentId) {
			const parentConfig = routeConfig[parentId]
			if (!parentConfig) break
			// Resolve the parent path by replacing $workspaceId param
			const params = leafMatch.params as Record<string, string>
			const parentPath = parentId
				.replace('/_authed', '')
				.replace('$workspaceId', params.workspaceId)
			crumbs.unshift({ label: parentConfig.label, path: parentPath })
			parentId = parentConfig.parent
		}
		// Add current page
		crumbs.push({ label: leafConfig.label, path: leafMatch.pathname })
	}

	// Object-detail pages drop the "Create an object" section from the New
	// menu — landing users on the generic object picker is disorienting when
	// they're mid-edit on a specific object. New chat/loop/agent/search stay.
	const isObjectDetail = leafMatch?.routeId === OBJECT_DETAIL_ROUTE_ID
	const isDetail = crumbs.length > 1
	const headingText = title ?? leafConfig?.label

	return (
		<header className="flex min-h-11 flex-none flex-wrap items-center gap-2 gap-y-1.5 border-b border-border px-[clamp(16px,4vw,44px)] py-1.5">
			<SidebarTrigger className="md:hidden -ml-1 h-[30px] w-[30px] shrink-0" />
			{isDetail && (
				<Button
					variant="ghost"
					size="icon"
					className="-ml-1 h-[30px] w-[30px] shrink-0"
					onClick={() => router.history.back()}
				>
					<ArrowLeft />
					<span className="sr-only">Go back</span>
				</Button>
			)}

			{stickyIdentity ? (
				<div className="flex min-w-0 flex-1 items-center gap-1 lg:gap-2">{stickyIdentity}</div>
			) : isDetail ? (
				<div className="hidden min-w-0 items-center text-muted-foreground md:flex">
					<Breadcrumb>
						<BreadcrumbList>
							{crumbs.map((crumb, index) => {
								const isLast = index === crumbs.length - 1
								return (
									<Fragment key={crumb.path}>
										{index > 0 && <BreadcrumbSeparator />}
										<BreadcrumbItem>
											{isLast ? (
												<BreadcrumbPage className="font-medium">{crumb.label}</BreadcrumbPage>
											) : (
												<BreadcrumbLink asChild>
													<a href={crumb.path}>{crumb.label}</a>
												</BreadcrumbLink>
											)}
										</BreadcrumbItem>
									</Fragment>
								)
							})}
						</BreadcrumbList>
					</Breadcrumb>
				</div>
			) : headingText ? (
				/* `flex-1` (basis 0), not the default `basis:auto`: flex line-breaking
				   decides wrapping from each item's max-content hypothetical size, so a
				   title block sized to its content pushed the New button onto a second
				   line at 375px — `truncate` alone could not prevent that, because
				   shrinking only happens after an item has been placed on a line.
				   Zero-basis lets the title give up width first and keeps the nav on
				   one line. */
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="truncate text-[clamp(17px,2vw,20px)] font-bold tracking-[-0.02em] text-foreground">
						{headingText}
					</h1>
					{subtitle && (
						<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
					)}
				</div>
			) : null}

			{/* `ml-auto` lives on the group, not on a spacer span: an auto margin
			    absorbs free space before flex-grow does, so a spacer would starve the
			    zero-basis title above. It still right-aligns the controls when no
			    heading or breadcrumb renders. */}
			<div className="ml-auto flex shrink-0 items-center gap-2">
				<NavSearch />
				{actions}
				<span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
				<NewMenu
					onNewChat={() => navigate({ to: '/$workspaceId/chats/new', params: { workspaceId } })}
					hideObjectSection={isObjectDetail}
					primaryKind={leafConfig?.primary ?? 'chat'}
				/>
			</div>
		</header>
	)
}
