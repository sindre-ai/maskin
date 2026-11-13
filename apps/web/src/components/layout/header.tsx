import { FLOATING_CONTROLS } from '@/components/shared/floating-footer'
import { NewMenu } from '@/components/shared/new-menu'
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
import { cn } from '@/lib/cn'
import { isHiddenRouteId } from '@/lib/nav-view-keys'
import { usePageHeader } from '@/lib/page-header-context'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useMatches, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Fragment, useLayoutEffect, useRef } from 'react'

interface RouteConfig {
	label: string
	parent?: string
}

const routeConfig: Record<string, RouteConfig> = {
	'/_authed/$workspaceId/': { label: 'For you' },
	'/_authed/$workspaceId/search': { label: 'Search' },
	'/_authed/$workspaceId/objects/': { label: 'Items' },
	'/_authed/$workspaceId/objects/$objectId': {
		label: 'Item Details',
		parent: '/_authed/$workspaceId/objects/',
	},
	'/_authed/$workspaceId/agents/': { label: 'Agents' },
	// Triggers keeps its own list route (deep links and bookmarks still resolve)
	// even though the v2 nav reaches triggers through Loops. Without an entry
	// here the screen renders with no title at all.
	//
	// Screens that render their own heading in the page body (Briefing, Chats'
	// conversation list, the new-chat composer) are deliberately absent — an
	// entry here would put a second heading of the same name in the nav row.
	'/_authed/$workspaceId/triggers/': { label: 'Triggers' },
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
	'/_authed/$workspaceId/settings/notifications': {
		label: 'Notifications',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/keychain/': {
		label: 'Keychain',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/mcp': {
		label: 'Keys and MCP',
		parent: '/_authed/$workspaceId/settings/',
	},
	'/_authed/$workspaceId/settings/objects/': {
		label: 'Item types',
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
	},
	// The mockup (1584) shows a middle crumb — `Loops › Not tied to a loop › name`
	// — but that middle term is the trigger's owning loop, or the literal
	// "Not tied to a loop" only when it has none. Crumbs here are derived from the
	// route, which cannot know either. A hardcoded middle crumb would be wrong on
	// every loop-owned trigger, so the chain stays `Loops › name`. Restoring it
	// means letting the page publish its own crumb, since only it has the loop.
	'/_authed/$workspaceId/loops/': { label: 'Flows' },
	'/_authed/$workspaceId/loops/new': {
		label: 'New flow',
		parent: '/_authed/$workspaceId/loops/',
	},
	'/_authed/$workspaceId/loops/$loopId': {
		label: 'Flow Details',
		parent: '/_authed/$workspaceId/loops/',
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
 * The bar floats over the page instead of sitting above it: it has no background at all, and
 * clicks pass through it except on its own controls.
 */
const FLOATING_BAR = `pointer-events-none absolute inset-x-0 top-[var(--app-banner-h,0px)] z-20 bg-background ${FLOATING_CONTROLS}`

/**
 * The shared top nav — mockup lines 155–279.
 *
 * One row per screen (34px title from `md:`, 28px side margin from `lg:`): the screen's <h1> and muted count on the left, then
 * the workspace search, the screen's own actions, a hairline divider, and the
 * split New button. It wraps rather than scrolls, so a narrow viewport drops the
 * right-hand cluster to a second line instead of hiding controls.
 *
 * The title resolves in three steps: a `stickyIdentity` the page supplied wins
 * (it is a richer identity element than a string), then the page's `title`, then
 * the route's own label. Detail routes keep a breadcrumb chain until their
 * screen lands and moves it into the page body, which is where v2 puts it.
 */
/**
 * What the title row is made of, shared by `Header` and `ScrollingPageTitle` so the two
 * can never disagree about who draws the title.
 *
 * `scrollsAway` is the design's standard screen: just a title (no breadcrumb, sticky
 * identity or title tabs). From `md:` its <h1> is drawn in the page content and scrolls
 * away with it, while the header keeps only the buttons, floating over the content.
 */
function useHeaderModel() {
	const matches = useMatches()
	const { title, crumb, stickyIdentity, titleTabs } = usePageHeader()

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
		// Add current page. Prefer the page's own published title over the static
		// route label so a detail crumb reads the record's name ("SEO content")
		// rather than the generic route name ("Loop Details").
		crumbs.push({ label: title ?? leafConfig.label, path: leafMatch.pathname })
	}

	const isDetail = crumbs.length > 1
	const headingText = title ?? leafConfig?.label
	const scrollsAway = !crumb && !stickyIdentity && !titleTabs && !isDetail && !!headingText
	return { leafMatch, crumbs, isDetail, headingText, scrollsAway }
}

/**
 * The screen's <h1> for a `scrollsAway` screen, drawn first in the page content so it
 * scrolls off with it (design). Hidden below `md:`, where the header row draws it.
 */
export function ScrollingPageTitle() {
	const { subtitle, hideTitle, hideBar } = usePageHeader()
	const { headingText, scrollsAway } = useHeaderModel()
	if (!scrollsAway || hideBar) return null
	return (
		// -mt-3 undoes 12px of the scroll area's 32px top padding so the row lines up with the
		// floating buttons at 20px; min-h keeps the row when the page draws its own title.
		<div className="hidden min-h-10 flex-none items-baseline gap-2 md:-mt-3 md:mb-4 md:flex">
			{!hideTitle && headingText && (
				<>
					<h1 className="page-title min-w-0 truncate md:py-0.5">{headingText}</h1>
					{subtitle && (
						<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
					)}
				</>
			)}
		</div>
	)
}

/**
 * Tells the scroll area how much room the floating bar needs at rest, through two CSS
 * variables on the bar's parent: its height (0 where it takes none, as on a screen whose
 * title scrolls away) and the gap that then separates it from the first row of content.
 */
function useReportBarSpace(
	ref: React.RefObject<HTMLElement | null>,
	takesNoHeightAtMd: boolean,
	gaps: { md: number; mobile: number },
) {
	useLayoutEffect(() => {
		const bar = ref.current
		const shell = bar?.parentElement
		if (!bar || !shell) return
		const wide = window.matchMedia('(min-width: 768px)')
		const apply = () => {
			const height = wide.matches && takesNoHeightAtMd ? 0 : bar.getBoundingClientRect().height
			shell.style.setProperty('--app-header-h', `${height}px`)
			shell.style.setProperty('--app-header-gap', `${wide.matches ? gaps.md : gaps.mobile}px`)
		}
		apply()
		const observer = new ResizeObserver(apply)
		observer.observe(bar)
		wide.addEventListener('change', apply)
		return () => {
			observer.disconnect()
			wide.removeEventListener('change', apply)
			shell.style.removeProperty('--app-header-h')
			shell.style.removeProperty('--app-header-gap')
		}
	}, [ref, takesNoHeightAtMd, gaps.md, gaps.mobile])
}

export function Header() {
	const {
		subtitle,
		actions,
		leadingActions,
		titleTabs,
		stickyIdentity,
		crumb,
		newMenuPrimaryOverride,
		newMenuDisabled,
		hideTitle,
		wrapActions,
		hideBar,
		gutter,
	} = usePageHeader()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const router = useRouter()
	const { leafMatch, crumbs, isDetail, headingText, scrollsAway } = useHeaderModel()
	const barRef = useRef<HTMLElement>(null)
	// From md a standard screen's title scrolls away and a hideBar page draws its own top edge,
	// so the bar reserves nothing there and the first row sits 32px down. Otherwise the gaps keep
	// the first row where the bar's old in-flow layout put it.
	const floatsAtMd = scrollsAway || !!hideBar
	useReportBarSpace(barRef, floatsAtMd, {
		md: floatsAtMd ? 32 : crumb ? 10 : 6,
		mobile: crumb ? 16 : 10,
	})

	// Object-detail pages drop the "Create an object" section from the New
	// menu — landing users on the generic object picker is disorienting when
	// they're mid-edit on a specific object. New chat/loop/agent/search stay.
	const isObjectDetail = leafMatch?.routeId === OBJECT_DETAIL_ROUTE_ID

	// A page that publishes its own crumb gets the mockup's compact detail bar
	// (1033–1039): `Parent › Name` at 12px and the page's own actions, with no
	// search, split New button or back arrow competing for the row.
	if (crumb) {
		return (
			<header
				ref={barRef}
				// v16: no rule under the bar. It floats over the page (see FLOATING_BAR); the scroll area
				// reserves its height, so nothing sits under it at rest.
				className={cn(
					FLOATING_BAR,
					'flex flex-wrap items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+13px)] pb-[13px] md:flex-nowrap md:px-8 md:pt-5 md:pb-3 lg:px-7',
				)}
			>
				<SidebarTrigger className="md:hidden -ml-0.5 h-[30px] w-[30px] shrink-0" />
				<Link
					to={crumb.parentTo}
					params={crumb.parentParams}
					className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{crumb.parentLabel}
				</Link>
				<span aria-hidden="true" className="shrink-0 text-xs text-border-strong">
					›
				</span>
				{crumb.middle && (
					<>
						{crumb.middle.to ? (
							<Link
								to={crumb.middle.to}
								params={crumb.middle.params}
								className="min-w-0 max-w-40 truncate text-xs text-muted-foreground transition-colors hover:text-foreground"
							>
								{crumb.middle.label}
							</Link>
						) : (
							<span className="min-w-0 max-w-40 truncate text-xs text-muted-foreground">
								{crumb.middle.label}
							</span>
						)}
						<span aria-hidden="true" className="shrink-0 text-xs text-border-strong">
							›
						</span>
					</>
				)}
				<span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
					{crumb.label}
				</span>
				{actions}
				{/* The same split New button every screen carries, last in the row
				    (mockup 925–946 puts it at `order:10`). */}
				<NewMenu
					onNewChat={() => navigate({ to: '/$workspaceId/chats/new', params: { workspaceId } })}
					primaryKind="chat"
					primaryOverride={newMenuPrimaryOverride}
					disabled={newMenuDisabled}
				/>
			</header>
		)
	}

	return (
		<header
			ref={barRef}
			className={cn(
				// Floats over the page (see FLOATING_BAR); the scroll area reserves its height.
				FLOATING_BAR,
				'flex flex-wrap items-center gap-2 gap-y-1.5 px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-3 md:px-8',
				// Standard screens (design): from md the title scrolls away with the page, so the header
				// takes no height and keeps only the buttons, floating over the content with no
				// background. Only the buttons take clicks; the rest of the strip lets them through.
				// hideBar: the page owns its whole top edge from md, so nothing draws here.
				hideBar && 'md:hidden',
				scrollsAway && 'md:justify-end md:pt-6 md:pb-0',
				gutter === 'wide' ? 'lg:px-12' : 'lg:px-7',
			)}
		>
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
				<div
					className={cn(
						'flex min-w-0 items-baseline gap-2',
						// A page with title tabs/search wants them right beside the title,
						// so the title block stops growing and the controls take the slack.
						// wrapActions: keep the title's own width so the buttons wrap below it.
						titleTabs || wrapActions ? 'shrink' : 'flex-1',
						// From md the scrolling title in the page content draws it instead.
						scrollsAway && 'md:hidden',
					)}
				>
					{/* hideTitle: a two-pane page draws its own title; the context's
					    title stays published for the crumb and document title. */}
					{!hideTitle && <h1 className="page-title truncate md:py-0.5">{headingText}</h1>}
					{subtitle && (
						<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
					)}
				</div>
			) : null}

			{/* Beside the title, before the right-hand cluster — the Objects type
			    tabs live in the left cluster (mockup 148–152), not out with search
			    and New. */}
			{titleTabs}

			{/* `ml-auto` lives on the group, not on a spacer span: an auto margin
			    absorbs free space before flex-grow does, so a spacer would starve the
			    zero-basis title above. It still right-aligns the controls when no
			    heading or breadcrumb renders. */}
			<div
				className={cn(
					'ml-auto flex shrink-0 items-center gap-2',
					scrollsAway && 'md:pointer-events-auto',
				)}
			>
				{leadingActions}
				{actions}
				<NewMenu
					onNewChat={() => navigate({ to: '/$workspaceId/chats/new', params: { workspaceId } })}
					hideObjectSection={isObjectDetail}
					primaryKind="chat"
					primaryOverride={newMenuPrimaryOverride}
					disabled={newMenuDisabled}
				/>
			</div>
		</header>
	)
}
