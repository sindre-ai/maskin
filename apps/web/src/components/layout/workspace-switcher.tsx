import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { trackSidebarWorkspaceSwitcherOpened } from '@/lib/analytics'
import type { WorkspaceWithRole } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown, Settings } from 'lucide-react'

export function WorkspaceSwitcher() {
	const { workspace, workspaceId } = useWorkspace()
	const { data: workspaces, isLoading, isError, refetch } = useWorkspaces()
	const { isMobile, setOpenMobile } = useSidebar()
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const currentFromList = workspaces?.find((ws) => ws.id === workspaceId)
	const displayName = currentFromList?.name ?? workspace?.name ?? workspaceId
	const initial = displayName.charAt(0).toUpperCase()

	function dropWorkspaceScopedCaches(id: string) {
		queryClient.removeQueries({ queryKey: queryKeys.objects.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.bets.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.actors.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.relationships.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.triggers.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.integrations.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.notifications.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.workspaceSkills.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.sessions.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.imports.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.files.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.subscriptions.unread(id) })
		queryClient.removeQueries({ queryKey: queryKeys.userDisplaySettings.list(id) })
		queryClient.removeQueries({ queryKey: queryKeys.installedLoops.all(id) })
		queryClient.removeQueries({ queryKey: queryKeys.marketplaceItems.installed(id) })
		queryClient.removeQueries({ queryKey: queryKeys.claudeOauth.status(id) })
		queryClient.removeQueries({ queryKey: queryKeys.events.history(id) })
	}

	function handleSelect(target: WorkspaceWithRole) {
		setOpenMobile(false)
		if (target.id === workspaceId) return
		dropWorkspaceScopedCaches(workspaceId)
		navigate({ to: '/$workspaceId', params: { workspaceId: target.id } })
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu
					onOpenChange={(open) => {
						if (open) trackSidebarWorkspaceSwitcherOpened({ workspaceId })
					}}
				>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							tooltip={displayName}
							aria-label={`Switch workspace, currently ${displayName}`}
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<div className="flex aspect-square size-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
								{initial}
							</div>
							<span className="truncate font-medium group-data-[collapsible=icon]:hidden">
								{isLoading ? (
									<Skeleton
										className="inline-block h-3 w-24 align-middle"
										data-testid="workspace-pill-skeleton"
									/>
								) : isError ? (
									workspaceId
								) : (
									displayName
								)}
							</span>
							<ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
						side={isMobile ? 'bottom' : 'right'}
						align="start"
						sideOffset={4}
					>
						<DropdownMenuLabel className="text-xs text-muted-foreground">
							Workspaces
						</DropdownMenuLabel>
						{isLoading ? (
							<DropdownMenuItem disabled>
								<Skeleton className="h-4 w-32" />
							</DropdownMenuItem>
						) : isError ? (
							<DropdownMenuItem onSelect={() => refetch()} className="gap-2 text-muted-foreground">
								<span className="truncate">Couldn't load workspaces — retry</span>
							</DropdownMenuItem>
						) : !workspaces || workspaces.length === 0 ? (
							<DropdownMenuItem disabled>
								<Check className="mr-2 size-4" />
								<span className="truncate">{displayName}</span>
							</DropdownMenuItem>
						) : (
							workspaces.map((ws) => {
								const isCurrent = ws.id === workspaceId
								return (
									<DropdownMenuItem key={ws.id} onSelect={() => handleSelect(ws)} className="gap-2">
										<span className="flex size-4 shrink-0 items-center justify-center">
											{isCurrent && <Check className="size-4" />}
										</span>
										<span className="flex min-w-0 flex-col">
											<span className="truncate text-sm font-medium text-foreground">
												{ws.name}
											</span>
											<span className="truncate text-xs text-muted-foreground">{ws.role}</span>
										</span>
									</DropdownMenuItem>
								)
							})
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => navigate({ to: '/$workspaceId/settings', params: { workspaceId } })}
							className="gap-2 text-muted-foreground"
						>
							<Settings className="size-4" />
							<span className="truncate">Workspace settings</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
