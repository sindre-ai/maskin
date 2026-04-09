import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'

export function WorkspaceSwitcher() {
	const { workspace, workspaceId } = useWorkspace()
	const { data: workspaces } = useWorkspaces()
	const navigate = useNavigate()
	const { isMobile, setOpenMobile } = useSidebar()

	const settings = workspace.settings as Record<string, unknown>
	const logoUrl = settings?.logo_url as string | undefined

	const allWorkspaces = workspaces ?? []

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							tooltip={workspace.name}
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<WorkspaceLogo name={workspace.name} logoUrl={logoUrl} />
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-semibold">{workspace.name}</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4 shrink-0" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
						side={isMobile ? 'bottom' : 'bottom'}
						align="start"
						sideOffset={4}
					>
						<DropdownMenuLabel className="text-xs text-muted-foreground">
							Workspaces
						</DropdownMenuLabel>
						{allWorkspaces.map((ws) => {
							const wsSettings = ws.settings as Record<string, unknown>
							const wsLogoUrl = wsSettings?.logo_url as string | undefined
							const isActive = ws.id === workspaceId
							return (
								<DropdownMenuItem
									key={ws.id}
									className="gap-2 p-2"
									onClick={() => {
										if (!isActive) {
											setOpenMobile(false)
											navigate({
												to: '/$workspaceId',
												params: { workspaceId: ws.id },
											})
										}
									}}
								>
									<WorkspaceLogo name={ws.name} logoUrl={wsLogoUrl} size="sm" />
									<span className="truncate">{ws.name}</span>
									{isActive && <Check className="ml-auto size-4" />}
								</DropdownMenuItem>
							)
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

function WorkspaceLogo({
	name,
	logoUrl,
	size = 'default',
}: {
	name: string
	logoUrl?: string
	size?: 'default' | 'sm'
}) {
	const [imgError, setImgError] = useState(false)
	const initial = name.charAt(0).toUpperCase()
	const sizeClasses = size === 'sm' ? 'size-5 text-[10px] rounded' : 'size-8 text-sm rounded-lg'

	if (logoUrl && !imgError) {
		return (
			<img
				src={logoUrl}
				alt=""
				className={cn('shrink-0 object-cover', sizeClasses)}
				onError={() => setImgError(true)}
			/>
		)
	}

	return (
		<div
			className={cn(
				'flex shrink-0 items-center justify-center bg-primary text-primary-foreground font-bold',
				sizeClasses,
			)}
		>
			{initial}
		</div>
	)
}
