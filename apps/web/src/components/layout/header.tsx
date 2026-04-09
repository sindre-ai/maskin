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
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { usePageHeader } from '@/lib/page-header-context'
import { useWorkspace } from '@/lib/workspace-context'
import { useMatches, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Bot, Layers, Plus, Zap } from 'lucide-react'
import { Fragment } from 'react'

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
	'/_authed/$workspaceId/activity': { label: 'Activity' },
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
}

const hiddenRoutes = new Set(['__root__', '/_authed', '/_authed/', '/_authed/$workspaceId'])

type CreateItem = {
	label: string
	icon: typeof Layers
	navigate: (nav: ReturnType<typeof useNavigate>, workspaceId: string) => void
}

const createItems: CreateItem[] = [
	{
		label: 'Object',
		icon: Layers,
		navigate: (nav, workspaceId) =>
			nav({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId: crypto.randomUUID() },
			}),
	},
	{
		label: 'Agent',
		icon: Bot,
		navigate: (nav, workspaceId) =>
			nav({
				to: '/$workspaceId/agents/$agentId',
				params: { workspaceId, agentId: crypto.randomUUID() },
			}),
	},
	{
		label: 'Trigger',
		icon: Zap,
		navigate: (nav, workspaceId) =>
			nav({
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: crypto.randomUUID() },
			}),
	},
]

export function Header() {
	const matches = useMatches()
	const { actions } = usePageHeader()
	const router = useRouter()
	const navigate = useNavigate()
	const { workspaceId } = useWorkspace()

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

	return (
		<header className="flex h-16 shrink-0 items-center gap-2">
			<div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
				<SidebarTrigger className="md:hidden -ml-1" />
				{crumbs.length > 1 && (
					<Button
						variant="ghost"
						size="icon"
						className="md:hidden -ml-1"
						onClick={() => router.history.back()}
					>
						<ArrowLeft />
						<span className="sr-only">Go back</span>
					</Button>
				)}
				<div className="hidden md:flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity duration-150 lg:gap-2">
					{crumbs.length > 1 && (
						<Button
							variant="ghost"
							size="icon"
							className="-ml-1"
							onClick={() => router.history.back()}
						>
							<ArrowLeft />
							<span className="sr-only">Go back</span>
						</Button>
					)}
					{crumbs.length > 0 && (
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
					)}
				</div>
				<div className="ml-auto flex items-center gap-2">
					{actions}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon">
								<Plus className="h-4 w-4" />
								<span className="sr-only">Create new</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{createItems.map((item) => {
								const Icon = item.icon
								return (
									<DropdownMenuItem
										key={item.label}
										onClick={() => item.navigate(navigate, workspaceId)}
									>
										<Icon className="h-4 w-4" />
										{item.label}
									</DropdownMenuItem>
								)
							})}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		</header>
	)
}
