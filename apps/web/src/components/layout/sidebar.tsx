import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from '@/components/ui/sidebar'
import { usePinnedPages } from '@/hooks/use-pinned-pages'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { GripVertical, LayoutGrid, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { AgentPulse } from '../agents/agent-pulse'
import { NavUser } from './nav-user'

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { setOpenMobile } = useSidebar()
	const { pinnedPages, isEditing, setEditing, unpin, reorder } = usePinnedPages()

	// Drag-and-drop state
	const dragIndex = useRef<number | null>(null)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

	const onDragStart = (index: number) => (e: React.DragEvent) => {
		dragIndex.current = index
		e.dataTransfer.effectAllowed = 'move'
	}

	const onDragOver = (index: number) => (e: React.DragEvent) => {
		e.preventDefault()
		if (dragIndex.current !== null && dragIndex.current !== index) {
			setDragOverIndex(index)
		}
	}

	const onDrop = (index: number) => (e: React.DragEvent) => {
		e.preventDefault()
		if (dragIndex.current !== null && dragIndex.current !== index) {
			reorder(dragIndex.current, index)
		}
		dragIndex.current = null
		setDragOverIndex(null)
	}

	const onDragEnd = () => {
		dragIndex.current = null
		setDragOverIndex(null)
	}

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="h-11 justify-center">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarTrigger />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					{/* Section header: "Pinned" label + "All" link + "Edit"/"Done" toggle */}
					<SidebarGroupLabel className="group-data-[collapsible=icon]:hidden justify-between pr-1">
						<span>Pinned</span>
						<div className="flex items-center gap-0.5 ml-auto">
							<Link
								to="/$workspaceId/pages"
								params={{ workspaceId }}
								className="rounded px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
								onClick={() => setEditing(false)}
							>
								All
							</Link>
							<button
								type="button"
								className="rounded px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
								onClick={() => setEditing(!isEditing)}
							>
								{isEditing ? 'Done' : 'Edit'}
							</button>
						</div>
					</SidebarGroupLabel>

					<SidebarMenu>
						{pinnedPages.map((page, index) => {
							const Icon = page.icon
							// Page routes are stored as runtime strings in the registry.
							// TanStack Router's Link/matchRoute require statically-typed routes,
							// so we cast here. The registry only contains valid app routes.
							// biome-ignore lint/suspicious/noExplicitAny: registry routes are valid at runtime
							const pageRoute = page.to as any
							const isActive = !!matchRoute({
								to: pageRoute,
								params: { workspaceId },
								fuzzy: !page.exact,
							})
							const isDragTarget = dragOverIndex === index

							return (
								<div
									key={page.id}
									draggable={isEditing}
									onDragStart={isEditing ? onDragStart(index) : undefined}
									onDragOver={isEditing ? onDragOver(index) : undefined}
									onDrop={isEditing ? onDrop(index) : undefined}
									onDragEnd={isEditing ? onDragEnd : undefined}
									className={cn(
										'flex items-center gap-0.5',
										isEditing && 'cursor-grab',
										isDragTarget && 'opacity-50',
									)}
								>
									{isEditing && (
										<GripVertical
											size={13}
											className="shrink-0 text-muted-foreground/50 group-data-[collapsible=icon]:hidden"
										/>
									)}
									<SidebarMenuItem className="flex-1 min-w-0">
										<SidebarMenuButton
											asChild={!isEditing}
											isActive={isActive}
											tooltip={page.label}
											onClick={isEditing ? undefined : () => setOpenMobile(false)}
										>
											{isEditing ? (
												<div className="flex items-center gap-2 w-full">
													<Icon size={16} />
													<span>{page.label}</span>
												</div>
											) : (
												<Link to={pageRoute} params={{ workspaceId }} search={{}}>
													<Icon />
													<span>{page.label}</span>
												</Link>
											)}
										</SidebarMenuButton>
									</SidebarMenuItem>
									{isEditing && (
										<button
											type="button"
											aria-label={`Unpin ${page.label}`}
											className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors group-data-[collapsible=icon]:hidden"
											onClick={() => unpin(page.id)}
										>
											<X size={12} />
										</button>
									)}
								</div>
							)
						})}

						{/* "All pages" entry — always visible, non-removable, hidden in icon-only mode */}
						<SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
							<SidebarMenuButton
								asChild
								isActive={!!matchRoute({ to: '/$workspaceId/pages', params: { workspaceId } })}
								tooltip="All pages"
							>
								<Link
									to="/$workspaceId/pages"
									params={{ workspaceId }}
									search={{}}
									onClick={() => {
										setOpenMobile(false)
										setEditing(false)
									}}
								>
									<LayoutGrid />
									<span className="text-muted-foreground">All pages</span>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
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
