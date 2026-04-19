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
	useSidebar,
} from '@/components/ui/sidebar'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledNavItems, getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Activity, BookOpen, Bot, type LucideIcon, Layers, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { AgentPulse } from '../agents/agent-pulse'
import { NavUser } from './nav-user'

const coreNavItems = [
	{ label: 'Pulse', to: '/$workspaceId' as const, exact: true, icon: Zap },
	{ label: 'Activity', to: '/$workspaceId/activity' as const, icon: Activity },
	{ label: 'Agents', to: '/$workspaceId/agents' as const, icon: Bot },
	{ label: 'Triggers', to: '/$workspaceId/triggers' as const, icon: Zap },
]

/**
 * Lucide icon names declared by module `navItems`. Extend when a new extension
 * uses an icon not already here — there is no runtime lookup in lucide-react.
 */
const MODULE_ICONS: Record<string, LucideIcon> = {
	'book-open': BookOpen,
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { setOpenMobile } = useSidebar()
	const enabledModules = useEnabledModules()

	const navItems = useMemo(() => {
		const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0
		const [pulse, ...rest] = coreNavItems
		const objectsItem = hasObjectTypes
			? [{ label: 'Objects', to: '/$workspaceId/objects' as const, icon: Layers }]
			: []
		const moduleItems = getEnabledNavItems(enabledModules)
			.map((item) => {
				const Icon = MODULE_ICONS[item.icon]
				if (!Icon) return null
				return {
					label: item.label,
					// Route paths are registered in `routeTree.gen.ts` from the file
					// structure. The `to` value is validated at render time by TanStack
					// Router; the cast is just to satisfy the union type used by
					// `coreNavItems`.
					to: `/$workspaceId/${item.path}` as (typeof coreNavItems)[number]['to'],
					icon: Icon,
				}
			})
			.filter((x): x is (typeof coreNavItems)[number] => !!x)
		return [pulse, ...objectsItem, ...moduleItems, ...rest]
	}, [enabledModules])

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

							return (
								<SidebarMenuItem key={item.to}>
									<SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
										<Link
											to={item.to}
											params={{ workspaceId }}
											search={{}}
											onClick={() => setOpenMobile(false)}
										>
											<Icon />
											<span>{item.label}</span>
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
