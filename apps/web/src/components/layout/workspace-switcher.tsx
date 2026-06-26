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
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown } from 'lucide-react'

function workspaceInitial(name: string | undefined | null) {
	const trimmed = name?.trim()
	return trimmed ? trimmed.charAt(0).toUpperCase() : '·'
}

export function WorkspaceSwitcher() {
	const { workspaceId } = useWorkspace()
	const { data: workspaces, isPending, isError } = useWorkspaces()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const { setOpenMobile, isMobile } = useSidebar()

	if (isPending) {
		return (
			<SidebarMenu>
				<SidebarMenuItem>
					<SidebarMenuButton
						size="lg"
						aria-label="Loading workspace"
						className="pointer-events-none"
					>
						<Skeleton className="size-6 shrink-0 rounded-md" />
						<Skeleton className="h-3 w-24 group-data-[collapsible=icon]:hidden" />
					</SidebarMenuButton>
				</SidebarMenuItem>
			</SidebarMenu>
		)
	}

	const current = workspaces?.find((ws) => ws.id === workspaceId)
	// AC-T2 error fallback: show a legible label derived from the URL workspaceId
	// so the pill never collapses while the sidebar shell stays put.
	const displayName =
		current?.name ?? (isError ? `Workspace ${workspaceId.slice(0, 6)}` : 'Workspace')
	const initial = workspaceInitial(current?.name ?? workspaceId)

	const handleSelect = (selectedId: string) => {
		if (selectedId === workspaceId) return
		if (isMobile) setOpenMobile(false)
		navigate({ to: '/$workspaceId', params: { workspaceId: selectedId } })
		// AC-T4: drop every cached workspace-scoped query so sessions, unread,
		// modules, objects and the rest refetch against the new workspace on the
		// first paint — no stale data from the previous workspace can leak.
		queryClient.invalidateQueries()
	}

	const hasWorkspaces = !!workspaces && workspaces.length > 0

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							tooltip={displayName}
							aria-label={`Workspace: ${displayName}. Open workspace switcher.`}
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<div
								aria-hidden="true"
								className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold"
							>
								{initial}
							</div>
							<span className="truncate font-medium group-data-[collapsible=icon]:hidden">
								{displayName}
							</span>
							<ChevronsUpDown className="ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
						align="start"
						side={isMobile ? 'bottom' : 'right'}
						sideOffset={4}
					>
						<DropdownMenuLabel className="text-xs text-muted-foreground">
							Workspaces
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{hasWorkspaces ? (
							workspaces.map((ws) => {
								const isCurrent = ws.id === workspaceId
								return (
									<DropdownMenuItem
										key={ws.id}
										onSelect={() => handleSelect(ws.id)}
										aria-current={isCurrent ? 'true' : undefined}
									>
										<div
											aria-hidden="true"
											className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary text-xs font-medium"
										>
											{workspaceInitial(ws.name)}
										</div>
										<span className="truncate">{ws.name}</span>
										{isCurrent && <Check className="ml-auto size-4 shrink-0" />}
									</DropdownMenuItem>
								)
							})
						) : (
							<DropdownMenuItem disabled>No workspaces available</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
