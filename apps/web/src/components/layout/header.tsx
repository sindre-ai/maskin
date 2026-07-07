import { CreatePicker } from '@/components/shared/create-picker'
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
import { useChat } from '@/lib/chat-context'
import { usePageHeader } from '@/lib/page-header-context'
import { useMatches, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Plus, Sparkles } from 'lucide-react'
import { Fragment, useState } from 'react'

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

export function Header() {
	const matches = useMatches()
	const { actions } = usePageHeader()
	const { setOpen: setChatOpen } = useChat()
	const router = useRouter()
	const [createOpen, setCreateOpen] = useState(false)

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
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{actions}
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						onClick={() => setCreateOpen(true)}
						aria-label="Create new"
						title="Create new…"
					>
						<Plus size={15} />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						onClick={() => setChatOpen(true)}
						aria-label="Open chat"
					>
						<Sparkles size={15} />
					</Button>
				</div>
			</div>
			<CreatePicker open={createOpen} onOpenChange={setCreateOpen} />
		</header>
	)
}
