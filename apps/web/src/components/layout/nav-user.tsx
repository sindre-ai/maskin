import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { clearAuth, getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useNavigate } from '@tanstack/react-router'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Check, LogOut, MoreVertical, UserCircle } from 'lucide-react'

export function NavUser() {
	const { workspaceId } = useWorkspace()
	const { data: workspaces } = useWorkspaces()
	const navigate = useNavigate()
	const { isMobile, setOpenMobile } = useSidebar()
	const actor = getStoredActor()

	const displayName = actor?.name ?? 'User'

	const currentWorkspace = workspaces?.find((ws) => ws.id === workspaceId)
	const otherWorkspaces = workspaces?.filter((ws) => ws.id !== workspaceId) ?? []

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton asChild tooltip={displayName}>
					<Link
						to="/$workspaceId/profile"
						params={{ workspaceId }}
						onClick={() => setOpenMobile(false)}
					>
						<ActorAvatar name={displayName} type={actor?.type ?? 'human'} size="sm" />
						<span className="truncate">{displayName}</span>
					</Link>
				</SidebarMenuButton>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuAction showOnHover aria-label="Account menu">
							<MoreVertical />
						</SidebarMenuAction>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-56 rounded-lg"
						side={isMobile ? 'bottom' : 'right'}
						align="end"
						sideOffset={4}
					>
						{workspaces && workspaces.length > 0 && (
							<>
								{isMobile ? (
									<>
										<DropdownMenuLabel className="text-xs text-muted-foreground">
											Workspace
										</DropdownMenuLabel>
										{currentWorkspace && (
											<DropdownMenuItem disabled>
												<Check className="mr-2 size-4" />
												{currentWorkspace.name}
											</DropdownMenuItem>
										)}
										{otherWorkspaces.map((ws) => (
											<DropdownMenuItem
												key={ws.id}
												onClick={() =>
													navigate({
														to: '/$workspaceId',
														params: { workspaceId: ws.id },
													})
												}
											>
												<span className="ml-6">{ws.name}</span>
											</DropdownMenuItem>
										))}
									</>
								) : (
									<DropdownMenuSub>
										<DropdownMenuSubTrigger>
											<UserCircle className="mr-2 size-4" />
											{currentWorkspace?.name ?? 'Switch workspace'}
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent className="min-w-48">
											{currentWorkspace && (
												<DropdownMenuItem disabled>
													<Check className="mr-2 size-4" />
													{currentWorkspace.name}
												</DropdownMenuItem>
											)}
											{otherWorkspaces.map((ws) => (
												<DropdownMenuItem
													key={ws.id}
													onClick={() =>
														navigate({
															to: '/$workspaceId',
															params: { workspaceId: ws.id },
														})
													}
												>
													<span className="ml-6">{ws.name}</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuSubContent>
									</DropdownMenuSub>
								)}
								<DropdownMenuSeparator />
							</>
						)}
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
