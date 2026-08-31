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
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { getActorAvatarPaletteClass } from '../shared/actor-avatar'
import { NewWorkspaceDialog } from './new-workspace-dialog'

// v2 labels a workspace by how many people are in it, not by the caller's role
// (mockup line 55's `w.sub`) — the menu is for picking a room, and "owner"
// says nothing about which room this is.
export function membersLabel(count: number): string {
	if (count <= 1) return 'just you'
	return `${count} members`
}

export function WorkspaceSwitcher() {
	const { workspace, workspaceId } = useWorkspace()
	const { data: workspaces, isLoading, isError, refetch } = useWorkspaces()
	const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [createOpen, setCreateOpen] = useState(false)

	const currentFromList = workspaces?.find((ws) => ws.id === workspaceId)
	const displayName = currentFromList?.name ?? workspace?.name ?? workspaceId
	const initial = displayName.charAt(0).toUpperCase()
	// On the rail the tile is the expand affordance, not the menu (mockup line
	// 108's `iconRailMenu` — "{wsName} · expand menu"). The workspace list has
	// nowhere to render at 60px wide, so opening it there would be a dead end.
	// Mobile is excluded: the sidebar is a Sheet, always at full width.
	const isRail = state === 'collapsed' && !isMobile

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

	// The rail has no room for a name, so the initial tile is the collapsed
	// identity. Expanded, v2 leads with the name itself (mockup line 45) — no
	// tile, no double identity.
	const label = (
		<>
			<div className="hidden aspect-square size-[30px] items-center justify-center rounded-lg bg-brand-subtle text-xs font-bold text-brand-subtle-foreground group-data-[collapsible=icon]:flex">
				{initial}
			</div>
			<span className="truncate text-sm font-bold tracking-[-0.01em] group-data-[collapsible=icon]:hidden">
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
			<ChevronDown className="ml-auto size-2.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
		</>
	)

	if (isRail) {
		return (
			<SidebarMenu>
				<SidebarMenuItem>
					<SidebarMenuButton
						tooltip={`${displayName} · expand menu`}
						aria-label="Expand sidebar"
						onClick={toggleSidebar}
					>
						{label}
					</SidebarMenuButton>
				</SidebarMenuItem>
			</SidebarMenu>
		)
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
							{label}
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-[212px]"
						side={isMobile ? 'bottom' : 'right'}
						align="start"
						sideOffset={4}
					>
						<DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
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
									<DropdownMenuItem
										key={ws.id}
										onSelect={() => handleSelect(ws)}
										className="gap-2.5"
									>
										{/* Each workspace gets its own identity colour, the way
										    the mockup gives V / N / P three different plates. */}
										<span
											className={cn(
												'flex size-6 shrink-0 items-center justify-center rounded-[7px] text-[10px] font-bold',
												getActorAvatarPaletteClass(ws.id),
											)}
										>
											{ws.name.charAt(0).toUpperCase()}
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-[12.5px] font-semibold text-foreground">
												{ws.name}
											</span>
											<span className="truncate text-[10.5px] text-muted-foreground">
												{membersLabel(ws.memberCount)}
											</span>
										</span>
										{isCurrent && <Check className="size-3 shrink-0 text-foreground" />}
									</DropdownMenuItem>
								)
							})
						)}
						<DropdownMenuSeparator />
						{/* Closing the drawer is not cosmetic on mobile: the sidebar is a
						    modal Sheet, so leaving it open after navigating parks an
						    overlay and `body { pointer-events: none }` over the page the
						    user just asked for — every tap after that does nothing.
						    handleSelect above closes it for the same reason. */}
						<DropdownMenuItem
							onSelect={() => {
								setOpenMobile(false)
								navigate({ to: '/$workspaceId/settings', params: { workspaceId } })
							}}
							className="gap-2 text-muted-foreground"
						>
							<span className="truncate">Workspace settings</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<NewWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
