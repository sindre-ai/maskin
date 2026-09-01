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
import { ChevronDown } from 'lucide-react'

export function NavUser() {
	const { workspace, workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { isMobile, setOpenMobile } = useSidebar()
	const actor = getStoredActor()

	const displayName = actor?.name ?? 'User'
	const displayEmail = actor?.email ?? ''
	const initial = displayName.charAt(0).toUpperCase()

	function goToSettings() {
		setOpenMobile(false)
		navigate({ to: '/$workspaceId/settings', params: { workspaceId } })
	}

	function goToProfile() {
		setOpenMobile(false)
		navigate({ to: '/$workspaceId/profile', params: { workspaceId } })
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						{/* Flat row, not a card: v2 gives the footer one rhythm — the
						    agents row and this one are the same shape, separated by
						    hover alone. A border here would make the person read as an
						    object in the nav rather than the frame around it. */}
						<SidebarMenuButton
							tooltip={displayName}
							// Without an explicit name this button's is the concatenation of
							// its contents — person *and* workspace. A default workspace is
							// named after its creator ("Ada's Workspace"), so that name then
							// collides with the switcher's "Switch workspace, currently …"
							// and a screen reader hears the person twice with no clue which
							// row does what. The prefix says what the control is first.
							aria-label={`Your account, ${displayName}`}
							className="h-auto rounded-lg py-[7px] data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
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
						{/* The identity plate repeats the trigger's tile so the menu reads
						    as an extension of the row it came from, and swaps the workspace
						    sub-line for the email — the one fact the row has no space for. */}
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-2 pb-[9px] pt-[7px] text-left">
								<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-[11px] font-bold text-brand-subtle-foreground">
									{initial}
								</span>
								<span className="grid min-w-0 flex-1 leading-[1.3]">
									<span className="truncate text-xs font-semibold">{displayName}</span>
									{displayEmail && (
										<span className="truncate text-[10.5px] text-muted-foreground">
											{displayEmail}
										</span>
									)}
								</span>
							</div>
						</DropdownMenuLabel>
						{/* No icons: v2's profile menu is a plain word list, and the only
						    rule it separates is the destructive one at the bottom. */}
						<DropdownMenuItem onClick={goToProfile} className="text-[12.5px]">
							Your profile
						</DropdownMenuItem>
						<DropdownMenuItem onClick={goToSettings} className="text-[12.5px]">
							Settings
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								clearAuth()
								navigate({ to: '/login' })
							}}
							className="text-[12.5px]"
						>
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
