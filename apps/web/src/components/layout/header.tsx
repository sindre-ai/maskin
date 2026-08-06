import { type CreatableType, CreatePicker } from '@/components/shared/create-picker'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { useChat } from '@/lib/chat-context'
import { useCommandPalette } from '@/lib/command-palette-context'
import { usePageHeader } from '@/lib/page-header-context'
import { useMatches, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Bot, ChevronDown, MessageSquare, Plus, RefreshCw, Search } from 'lucide-react'
import { Fragment, useState } from 'react'

interface CreateConfig {
	type: CreatableType
	subtype?: string
}

const OBJECT_TYPE_ITEMS: { subtype: string; label: string; swatchClassName: string }[] = [
	{ subtype: 'task', label: 'Task', swatchClassName: 'bg-type-task-bg' },
	{ subtype: 'insight', label: 'Insight', swatchClassName: 'bg-type-insight-bg' },
	{ subtype: 'bet', label: 'Bet', swatchClassName: 'bg-type-bet-bg' },
]

interface RouteConfig {
	label: string
	parent?: string
}

const routeConfig: Record<string, RouteConfig> = {
	'/_authed/$workspaceId/': { label: 'For You' },
	'/_authed/$workspaceId/objects/': { label: 'Objects' },
	'/_authed/$workspaceId/objects/$objectId': {
		label: 'Object Details',
		parent: '/_authed/$workspaceId/objects/',
	},
	'/_authed/$workspaceId/agents': { label: 'Agents' },
	'/_authed/$workspaceId/settings/': { label: 'Settings' },
	'/_authed/$workspaceId/settings/keys': {
		label: 'LLM',
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
	'/_authed/$workspaceId/triggers/': {
		label: 'Triggers',
	},
	'/_authed/$workspaceId/triggers/$triggerId': {
		label: 'Trigger Details',
		parent: '/_authed/$workspaceId/triggers/',
	},
	'/_authed/$workspaceId/loops/': {
		label: 'Loops',
	},
	'/_authed/$workspaceId/loops/$loopId': {
		label: 'Loop Details',
		parent: '/_authed/$workspaceId/loops/',
	},
}

const hiddenRoutes = new Set(['__root__', '/_authed', '/_authed/', '/_authed/$workspaceId'])

const OBJECT_DETAIL_ROUTE_ID = '/_authed/$workspaceId/objects/$objectId'
const FOR_YOU_ROUTE_ID = '/_authed/$workspaceId/'

export function Header() {
	const matches = useMatches()
	const { actions, stickyIdentity } = usePageHeader()
	const { setOpen: setChatOpen } = useChat()
	const { setOpen: setPaletteOpen } = useCommandPalette()
	const router = useRouter()
	const [createConfig, setCreateConfig] = useState<CreateConfig | null>(null)

	// Find the leaf (last non-hidden) match
	const leafMatch = [...matches].reverse().find((m) => !hiddenRoutes.has(m.routeId))
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
	// The For You page's own header already surfaces equivalent actions
	// (title, "Today's brief", "New") — the global Create/Chat icons here
	// would just duplicate them.
	const isForYouPage = leafMatch?.routeId === FOR_YOU_ROUTE_ID

	const parentCrumbs = crumbs.slice(0, -1)
	const hasSticky = Boolean(stickyIdentity)

	return (
		<header className="relative flex h-11 shrink-0 items-center gap-2 after:pointer-events-none after:absolute after:top-full after:right-0 after:left-0 after:z-10 after:h-8 after:bg-gradient-to-b after:from-background after:to-transparent after:content-['']">
			<div className="flex w-full min-w-0 items-center gap-1 px-3 lg:gap-2 lg:px-4">
				<SidebarTrigger className="md:hidden -ml-1 h-7 w-7 shrink-0" />
				{crumbs.length > 1 && (
					<Button
						variant="ghost"
						size="icon"
						className="md:hidden -ml-1 h-7 w-7 shrink-0"
						onClick={() => router.history.back()}
					>
						<ArrowLeft />
						<span className="sr-only">Go back</span>
					</Button>
				)}
				<div className="hidden md:flex min-w-0 flex-1 items-center gap-1 text-muted-foreground hover:text-foreground transition-colors duration-150 lg:gap-2">
					{crumbs.length > 1 && (
						<Button
							variant="ghost"
							size="icon"
							className="-ml-1 h-7 w-7"
							onClick={() => router.history.back()}
						>
							<ArrowLeft />
							<span className="sr-only">Go back</span>
						</Button>
					)}
					{hasSticky ? (
						<div className="flex min-w-0 flex-1 items-center gap-1 lg:gap-2">
							{parentCrumbs.length > 0 && (
								<div className="hidden xl:flex min-w-0 items-center">
									<Breadcrumb>
										<BreadcrumbList>
											{parentCrumbs.map((crumb, index) => (
												<Fragment key={crumb.path}>
													{index > 0 && <BreadcrumbSeparator />}
													<BreadcrumbItem>
														<BreadcrumbLink asChild>
															<a href={crumb.path}>{crumb.label}</a>
														</BreadcrumbLink>
													</BreadcrumbItem>
												</Fragment>
											))}
											<BreadcrumbSeparator />
										</BreadcrumbList>
									</Breadcrumb>
								</div>
							)}
							<div className="min-w-0 flex-1">{stickyIdentity}</div>
						</div>
					) : (
						crumbs.length > 0 && (
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
						)
					)}
				</div>
				{hasSticky && (
					<div className="md:hidden flex min-w-0 flex-1 items-center overflow-hidden">
						{stickyIdentity}
					</div>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{actions}
					{!isForYouPage && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button size="sm" aria-label="New" className="h-7 gap-1 px-2">
									<Plus size={14} aria-hidden />
									<span className="hidden sm:inline">New</span>
									<ChevronDown size={12} aria-hidden className="opacity-70" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-72">
								<DropdownMenuItem
									onSelect={() => setChatOpen(true)}
									className="items-start gap-2.5 py-2"
								>
									<span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
										<MessageSquare size={13} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block text-sm font-medium">New chat</span>
										<span className="block text-xs text-muted-foreground">
											Talk — your agents have the context
										</span>
									</span>
								</DropdownMenuItem>
								{!isObjectDetail && (
									<>
										<DropdownMenuSeparator />
										<div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
											Create an object
										</div>
										{OBJECT_TYPE_ITEMS.map((item) => (
											<DropdownMenuItem
												key={item.subtype}
												onSelect={() => setCreateConfig({ type: 'object', subtype: item.subtype })}
											>
												<span
													className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${item.swatchClassName}`}
												/>
												New {item.label.toLowerCase()}
											</DropdownMenuItem>
										))}
									</>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => setCreateConfig({ type: 'loop' })}>
									<RefreshCw size={14} className="text-muted-foreground" />
									New loop
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => setCreateConfig({ type: 'agent' })}>
									<Bot size={14} className="text-muted-foreground" />
									New agent
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => setPaletteOpen(true)}>
									<Search size={14} className="text-muted-foreground" />
									Find a past conversation
									<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>
			<CreatePicker
				open={createConfig !== null}
				onOpenChange={(next) => {
					if (!next) setCreateConfig(null)
				}}
				defaultType={createConfig?.type}
				defaultObjectSubtype={createConfig?.subtype}
			/>
		</header>
	)
}
