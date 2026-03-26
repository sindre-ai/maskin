import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
} from '@/components/ui/sidebar'
import { useNotifications } from '@/hooks/use-notifications'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Activity, Bot, Layers, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { AgentPulse } from '../agents/agent-pulse'
import { NavUser } from './nav-user'

const navItems = [
	{ label: 'Pulse', to: '/$workspaceId' as const, exact: true, icon: Zap, badge: true },
	{ label: 'Objects', to: '/$workspaceId/objects' as const, icon: Layers },
	{ label: 'Activity', to: '/$workspaceId/activity' as const, icon: Activity },
	{ label: 'Agents', to: '/$workspaceId/agents' as const, icon: Bot },
	{ label: 'Triggers', to: '/$workspaceId/triggers' as const, icon: Zap },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { data: notifications } = useNotifications(workspaceId)

	const pendingCount = useMemo(
		() =>
			(notifications ?? []).filter((n) => n.status === 'pending' || n.status === 'seen').length,
		[notifications],
	)

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="h-16 justify-center">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarTrigger />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{navItems.map((item) => {
							const Icon = item.icon
							const isActive = !!matchRoute({
								to: item.to,
								params: { workspaceId },
								fuzzy: !('exact' in item),
							})
							const count = item.badge ? pendingCount : 0

							return (
								<SidebarMenuItem key={item.to}>
									<SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
										<Link to={item.to} params={{ workspaceId }}>
											<Icon />
											<span className="flex-1">{item.label}</span>
											{count > 0 && (
												<span className="ml-auto text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground group-data-[collapsible=icon]:hidden">
													{count}
												</span>
											)}
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)
						})}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<div className="px-2 group-data-[collapsible=icon]:hidden">
					<AgentPulse workspaceId={workspaceId} />
				</div>
				<NavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
