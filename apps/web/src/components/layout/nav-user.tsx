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
import { clearAuth, getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, LogOut, Settings } from 'lucide-react'

export function NavUser() {
	const { workspace, workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { isMobile, setOpenMobile } = useSidebar()
	const actor = getStoredActor()

	const displayName = actor?.name ?? 'User'
	const displayEmail = actor?.email ?? ''
	const initial = displayName.charAt(0).toUpperCase()

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							tooltip={displayName}
							className="h-auto data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-[10px] font-bold text-brand-subtle-foreground">
								{initial}
							</span>
							{/* The row identifies the person and the workspace they are in —
							    the mockup pairs them because one account spans several. */}
							<span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
								<span className="truncate text-xs font-semibold">{displayName}</span>
								{workspace?.name && (
									<span className="truncate text-[10.5px] text-muted-foreground">
										{workspace.name}
									</span>
								)}
							</span>
							<ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
						side={isMobile ? 'bottom' : 'right'}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
									<span className="text-xs font-bold">{initial}</span>
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-semibold">{displayName}</span>
									{displayEmail && (
										<span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
									)}
								</div>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								setOpenMobile(false)
								navigate({
									to: '/$workspaceId/settings',
									params: { workspaceId },
								})
							}}
						>
							<Settings className="mr-2 size-4" />
							Settings
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								clearAuth()
								navigate({ to: '/login' })
							}}
						>
							<LogOut className="mr-2 size-4" />
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
